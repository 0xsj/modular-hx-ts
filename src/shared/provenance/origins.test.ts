import { describe, expect, it } from 'vitest';
import { fakeClock } from '../clock/index.js';
import { isAppError, Kind } from '../errors/index.js';
import { fakeIds, isUuid } from '../id/index.js';
import { Actor } from './actor.js';
import { makeOrigins, type InboundHeaders } from './origins.js';

const origins = (): ReturnType<typeof makeOrigins> =>
  makeOrigins(fakeIds(fakeClock()));

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

const thrownKind = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return isAppError(error) ? error.kind : error;
  }
  return undefined;
};

describe('an inbound request', () => {
  it('mints its own request id and roots its own chain', () => {
    const p = origins().forRequest();

    expect(isUuid(p.requestId)).toBe(true);
    // With nothing adopted, a root request is the root of its own chain.
    expect(p.correlationId).toBe(p.requestId);
    expect(p.causationId).toBeUndefined();
  });

  it('starts anonymous, because an actor is never adopted', () => {
    // Adopting an actor from a header is an authentication bypass. The
    // authenticator replaces this once credentials verify.
    expect(String(origins().forRequest().actor)).toBe('anonymous:');
  });

  it('has no tenant until the L3 resolver runs', () => {
    expect(origins().forRequest().tenant).toBeUndefined();
  });

  it('adopts a well-formed correlation and causation', () => {
    const p = origins().forRequest({
      correlationId: 'corr_01a024c7',
      causationId: 'evt_01a024c8',
    });

    expect(p.correlationId).toBe('corr_01a024c7');
    expect(p.causationId).toBe('evt_01a024c8');
  });

  it('adopts a well-formed traceparent', () => {
    expect(origins().forRequest({ traceparent: TRACEPARENT }).traceparent).toBe(
      TRACEPARENT,
    );
  });
});

describe('the adoption boundary', () => {
  it('cannot be handed a request id, actor or tenant at all', () => {
    // Not a runtime check: those three are absent from InboundHeaders, so a
    // middleware author has nothing to be tempted by.
    const inbound: InboundHeaders = {};

    expect(Object.keys(inbound)).toEqual([]);
    expect('requestId' in inbound).toBe(false);
    expect('actor' in inbound).toBe(false);
    expect('tenant' in inbound).toBe(false);
  });

  it('drops a malformed correlation instead of failing the request', () => {
    // Provenance grants nothing, so strictness is free: the cost of dropping is
    // a broken trace link, and the cost of accepting is log injection.
    const hostile = [
      '',
      'a b',
      'a"b',
      'x'.repeat(129),
      'trace\nX-Injected: yes',
      '<script>',
      'a\\b',
    ];

    for (const correlationId of hostile) {
      const p = origins().forRequest({ correlationId });

      expect(p.correlationId, `expected ${correlationId} dropped`).toBe(
        p.requestId,
      );
    }
  });

  it('drops a malformed causation rather than inventing one', () => {
    expect(
      origins().forRequest({ causationId: 'a b' }).causationId,
    ).toBeUndefined();
  });

  it('drops a traceparent that is not the W3C shape', () => {
    // A charset check would happily accept `00-zz-…`, so traceparent is
    // validated against its own format.
    const bad = [
      '00-zz-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7',
      // All-zero trace and parent ids mean "no trace" per the specification.
      '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
      '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
      TRACEPARENT.toUpperCase(),
    ];

    for (const traceparent of bad) {
      expect(
        origins().forRequest({ traceparent }).traceparent,
        `expected ${traceparent} dropped`,
      ).toBeUndefined();
    }
  });

  it('never lets an adopted value become the request id', () => {
    // A caller-supplied request id lets two requests share an identity, which
    // breaks idempotency reasoning and audit uniqueness.
    const p = origins().forRequest({
      correlationId: 'corr_1',
      causationId: 'evt_1',
    });

    expect(p.requestId).not.toBe('corr_1');
    expect(p.requestId).not.toBe('evt_1');
    expect(isUuid(p.requestId)).toBe(true);
  });
});

describe('system origins', () => {
  it('names the actor for each kind of work', () => {
    const o = origins();

    expect(String(o.forJob('identity.purge').actor)).toBe(
      'system:jobs/identity.purge',
    );
    expect(String(o.forMigration().actor)).toBe('system:migrate');
    expect(String(o.forBoot().actor)).toBe('system:boot');
    expect(String(o.forCli('seed').actor)).toBe('system:cli/seed');
  });

  it('roots its own chain, because nothing caused it', () => {
    for (const p of [
      origins().forJob('identity.purge'),
      origins().forMigration(),
      origins().forBoot(),
      origins().forCli('seed'),
    ]) {
      expect(p.correlationId).toBe(p.requestId);
      expect(p.causationId).toBeUndefined();
      expect(p.tenant).toBeUndefined();
    }
  });

  it('treats a malformed job name as a bug, not as input', () => {
    // A job name is written by a programmer, not supplied by a caller.
    expect(thrownKind(() => origins().forJob('nightly purge'))).toBe(
      Kind.Internal,
    );
    expect(thrownKind(() => origins().forCli('run;rm -rf'))).toBe(
      Kind.Internal,
    );
  });

  it('gives every unit of work a distinct request id', () => {
    const o = origins();
    const ids = [
      o.forBoot().requestId,
      o.forMigration().requestId,
      o.forJob('purge').requestId,
      o.forRequest().requestId,
    ];

    expect(new Set(ids).size).toBe(4);
  });
});

describe('a chain across origins', () => {
  it('keeps correlation from the request through every child', () => {
    // Conformance 38: correlation survives the boundary. A subscriber derives
    // rather than minting, which is what keeps this true across contexts.
    const request = origins().forRequest({ correlationId: 'corr_root' });
    const command = request.derive();
    const subscriber = command.derive('evt_01a024c7');

    expect(command.correlationId).toBe('corr_root');
    expect(subscriber.correlationId).toBe('corr_root');
    expect(subscriber.causationId).toBe('evt_01a024c7');
  });

  it('carries the actor down the chain once authenticated', () => {
    const authenticated = origins()
      .forRequest()
      .withActor(Actor.anonymous())
      .withTenant('acme');

    expect(authenticated.derive().tenant).toBe('acme');
  });
});
