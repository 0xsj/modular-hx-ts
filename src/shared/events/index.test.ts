import { describe, expect, it } from 'vitest';
import { fakeClock } from '../clock/index.js';
import { fakeIds } from '../id/index.js';
import { unwrap } from '../result/index.js';
import { fakeProvenance } from '../provenance/provenance.testkit.js';
import { eventsContract } from './eventstest.js';
import { contextOf, event, isEventName } from './event.js';
import { Envelope, provenanceFor } from './envelope.js';
import { matches } from './ports.js';
import { memoryEvents } from './memory.js';

describe('event names', () => {
  it('are <context>.<entity>.<verb>', () => {
    expect(isEventName('identity.user.registered')).toBe(true);
    expect(isEventName('orgs.membership.revoked')).toBe(true);
  });

  it('refuse anything else, so M6 has a shape to check', () => {
    // Two segments is ambiguous about which half is the context; four invites a
    // hierarchy nothing consumes.
    for (const bad of [
      'user.registered',
      'identity.user',
      'identity.user.registered.v2',
      'Identity.user.registered',
      'identity..registered',
      '',
    ]) {
      expect(isEventName(bad), `${bad} should be refused`).toBe(false);
    }
  });

  it('name the context M6 compares against', () => {
    expect(contextOf('identity.user.registered')).toBe('identity');
  });
});

describe('payloads carry primitives only', () => {
  it('accept primitives and arrays of them', () => {
    const e = event('identity.user.registered', {
      id: 'u1',
      count: 2,
      active: true,
      deleted_at: null,
      roles: ['admin', 'member'],
    });
    expect(e.ok).toBe(true);
  });

  it('refuse a Date, and say what to send instead', () => {
    // A Date serializes three ways across the collection. The payload outlives
    // the process and is read by code compiled against another version.
    const e = event('identity.user.registered', {
      at: new Date() as unknown as string,
    });
    expect(e.ok).toBe(false);
    expect(String(e.ok ? '' : e.error)).toContain('ISO string');
  });

  it('refuse a nested object', () => {
    const e = event('identity.user.registered', {
      user: { id: 'u1' } as unknown as string,
    });
    expect(e.ok).toBe(false);
  });
});

describe('subscription patterns', () => {
  it('match a name exactly or a context prefix', () => {
    expect(
      matches('identity.user.registered', 'identity.user.registered'),
    ).toBe(true);
    expect(matches('identity.*', 'identity.user.registered')).toBe(true);
    expect(matches('orgs.*', 'identity.user.registered')).toBe(false);
    expect(matches('identity.user.registered', 'identity.user.deleted')).toBe(
      false,
    );
  });
});

describe('the envelope constructor is where M5 lives', () => {
  it('cannot be built without provenance', () => {
    // The detect clause for M5 is *publish goes through the envelope
    // constructor, which requires them*. A type stops a TypeScript caller; this
    // stops everyone else.
    const clock = fakeClock();
    const ids = fakeIds(clock);
    const e = unwrap(event('identity.user.registered'));

    expect(() =>
      Envelope.seal(e, undefined as never, ids.uuid(), clock.now()),
    ).toThrow();
  });

  it('round-trips through the wire, provenance included', () => {
    const clock = fakeClock();
    const ids = fakeIds(clock);
    const provenance = fakeProvenance({ tenant: 'acme' });
    const sealed = Envelope.seal(
      unwrap(event('identity.user.registered', { id: 'u1' })),
      provenance,
      ids.uuid(),
      clock.now(),
    );

    const back = Envelope.fromWire(sealed.toJSON(), () => ids.uuid());

    expect(back.ok).toBe(true);
    const restored = unwrap(back);
    expect(restored.id).toBe(sealed.id);
    expect(restored.payload).toEqual({ id: 'u1' });
    expect(restored.provenance.correlationId).toBe(provenance.correlationId);
    expect(restored.provenance.tenant).toBe('acme');
    expect(restored.occurredAt.toISOString()).toBe(
      sealed.occurredAt.toISOString(),
    );
  });

  it('refuses bytes it cannot read rather than half-building one', () => {
    const clock = fakeClock();
    const ids = fakeIds(clock);
    const wire = {
      id: 'x',
      name: 'identity.user.registered',
      occurred_at: 'not a date',
      payload: {},
      provenance: {},
    };

    expect(Envelope.fromWire(wire as never, () => ids.uuid()).ok).toBe(false);
  });
});

describe('provenanceFor is the subscriber rule', () => {
  it('derives rather than mints', () => {
    // PROVENANCE.md §4. A restored envelope must still derive, which is why
    // fromWire takes a mint function.
    const clock = fakeClock();
    const ids = fakeIds(clock);
    const parent = fakeProvenance();
    const sealed = Envelope.seal(
      unwrap(event('identity.user.registered')),
      parent,
      ids.uuid(),
      clock.now(),
    );

    const derived = provenanceFor(sealed);

    expect(derived.correlationId).toBe(parent.correlationId);
    expect(derived.causationId).toBe(sealed.id);
    expect(derived.requestId).not.toBe(parent.requestId);
  });
});

describe('the memory provider', () => {
  eventsContract(() => {
    const clock = fakeClock();
    const events = memoryEvents({ clock, ids: fakeIds(clock) });
    return {
      events,
      name: 'memory',
      provenance: () => fakeProvenance(),
      // Publish already dispatched in-process, so there is nothing pending.
      settle: () => undefined,
      // A genuine second dispatch of the same envelope. The first version of
      // this looked through `published()` and returned without delivering
      // anything, which made the at-least-once case pass for the wrong reason.
      redeliver: (envelope) => events.redeliver(envelope),
    };
  });
});
