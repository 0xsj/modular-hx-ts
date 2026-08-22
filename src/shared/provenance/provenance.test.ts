import { describe, expect, it } from 'vitest';
import { canonicalize, digest } from '../digest/index.js';
import { Kind } from '../errors/index.js';
import { isErr, unwrap } from '../result/index.js';
import { Actor } from './actor.js';
import { createProvenance, Provenance } from './provenance.js';
import { fakeProvenance } from './provenance.testkit.js';

/** A deterministic id source, so every assertion can name the exact value. */
function sequence(prefix = 'req'): () => string {
  let next = 0;
  return () => `${prefix}_${String(++next).padStart(3, '0')}`;
}

function root(overrides: Partial<Parameters<typeof createProvenance>[0]> = {}) {
  const mint = sequence();
  return createProvenance({
    requestId: mint(),
    correlationId: 'corr_abc',
    causationId: undefined,
    actor: unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844')),
    tenant: undefined,
    traceparent: undefined,
    mint,
    ...overrides,
  });
}

describe('derive', () => {
  it('inherits the chain and mints a new request id', () => {
    const parent = root();
    const child = parent.derive();

    expect(child.correlationId).toBe(parent.correlationId);
    expect(child.actor.equals(parent.actor)).toBe(true);
    expect(child.requestId).not.toBe(parent.requestId);
  });

  it('records the parent as the cause by default', () => {
    const parent = root();

    expect(parent.derive().causationId).toBe(parent.requestId);
  });

  it('takes an explicit cause, which is what a subscriber needs', () => {
    // A subscriber's cause is the event id, not the publishing request. That is
    // why the primitive takes `causedBy` rather than an envelope: provenance is
    // L1, events is L2, and the import would be permanently upward.
    const child = root().derive('evt_01a024c7');

    expect(child.causationId).toBe('evt_01a024c7');
  });

  it('never lets a unit of work cause itself', () => {
    // Hand-building a child is how a parent's request id becomes the child's,
    // collapsing the causal graph into a self-loop.
    const child = root().derive();

    expect(child.causationId).not.toBe(child.requestId);
  });

  it('keeps correlation stable down a long chain', () => {
    // Conformance 38 in miniature: correlation survives every boundary.
    let current = root();
    const chain = [current];

    for (let hop = 0; hop < 5; hop++) {
      current = current.derive();
      chain.push(current);
    }

    expect(new Set(chain.map((p) => p.correlationId)).size).toBe(1);
    expect(new Set(chain.map((p) => p.requestId)).size).toBe(6);
    // Each link names the one before it.
    for (let hop = 1; hop < chain.length; hop++) {
      expect(chain[hop]?.causationId).toBe(chain[hop - 1]?.requestId);
    }
  });

  it('carries the id source, so a child can have children', () => {
    expect(root().derive().derive().derive().requestId).toBe('req_004');
  });
});

describe('attribution', () => {
  it('replaces the actor without disturbing the unit of work', () => {
    // The authenticator sets this after credentials verify; it is never adopted.
    const anonymous = root({ actor: Actor.anonymous() });
    const authenticated = anonymous.withActor(
      unwrap(Actor.service('webhooks')),
    );

    expect(authenticated.requestId).toBe(anonymous.requestId);
    expect(authenticated.correlationId).toBe(anonymous.correlationId);
    expect(String(authenticated.actor)).toBe('service:webhooks');
    expect(String(anonymous.actor)).toBe('anonymous:');
  });

  it('scopes to a tenant, which is null until the L3 resolver runs', () => {
    const before = root();
    const after = before.withTenant('acme');

    expect(before.tenant).toBeUndefined();
    expect(after.tenant).toBe('acme');
    expect(after.requestId).toBe(before.requestId);
  });

  it('is immutable: every change returns a new value', () => {
    const original = root();

    expect(original.withTenant('acme')).not.toBe(original);
    expect(original.withActor(Actor.anonymous())).not.toBe(original);
    expect(original.tenant).toBeUndefined();
  });
});

describe('the of-record form', () => {
  it('omits absent fields, never emits null', () => {
    // §6: an absent key and a null value are different documents with different
    // digests under RFC 8785. This is where cross-language parity is lost, and
    // it is lost silently.
    const wire = root().toJSON();

    expect('causation_id' in wire).toBe(false);
    expect('tenant' in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toContain('null');
  });

  it('uses the exact snake_case keys that get hashed', () => {
    const wire = root().derive('evt_1').withTenant('acme').toJSON();

    expect(Object.keys(wire).sort()).toEqual([
      'actor',
      'causation_id',
      'correlation_id',
      'request_id',
      'tenant',
    ]);
  });

  it('excludes traceparent, which would break digest stability', () => {
    // traceparent changes per trace, so hashing it gives the same logical
    // action a different digest every time — destroying deduplication.
    const traced = root().withTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );

    expect(traced.traceparent).toBeDefined();
    expect(JSON.stringify(traced.toJSON())).not.toContain('4bf92f35');
    // Same logical action, same digest, whether or not it was traced.
    expect(unwrap(digest(traced.toJSON()))).toBe(
      unwrap(digest(root().toJSON())),
    );
  });

  it('canonicalizes identically with causation_id and tenant absent', () => {
    // The conformance case §10 says nothing currently covers. Two provenances
    // built by different routes, same logical record, same bytes.
    const built = root();
    const readBack = unwrap(Provenance.fromWire(sequence(), built.toJSON()));

    expect(unwrap(canonicalize(readBack.toJSON()))).toBe(
      unwrap(canonicalize(built.toJSON())),
    );
    expect(unwrap(digest(readBack.toJSON()))).toBe(
      unwrap(digest(built.toJSON())),
    );
  });

  it('canonicalizes to bytes anything can reproduce', () => {
    const wire = root().toJSON();

    expect(unwrap(canonicalize(wire))).toBe(
      '{"actor":{"id":"01a024c7-d2d6-7e71-8c87-e344e27ef844","kind":"user"},' +
        '"correlation_id":"corr_abc","request_id":"req_001"}',
    );
  });
});

describe('digest refuses to guess', () => {
  it('will not canonicalize the value itself, only its of-record form', () => {
    // `digest` deliberately does not honour `toJSON` the way JSON.stringify
    // does: Go and Python have no implicit equivalent, so requiring an explicit
    // conversion at the stamp point is what keeps the languages in step.
    const result = canonicalize(root());

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.message).toContain(
      'no canonical JSON form',
    );
  });
});

describe('fromWire', () => {
  it('round-trips a fully populated record', () => {
    const original = root().derive('evt_1').withTenant('acme');
    const readBack = unwrap(Provenance.fromWire(sequence(), original.toJSON()));

    expect(readBack.equals(original)).toBe(true);
  });

  it('preserves both principals', () => {
    // Reconstructing an actor through its `kind:id` string would drop
    // on_behalf_of, and a record that verified when written would stop
    // verifying when read.
    const agent = unwrap(Actor.service('support')).actingFor(
      unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844')),
    );
    const original = root({ actor: agent });

    const readBack = unwrap(Provenance.fromWire(sequence(), original.toJSON()));

    expect(readBack.actor.onBehalfOf?.id).toBe(
      '01a024c7-d2d6-7e71-8c87-e344e27ef844',
    );
    expect(readBack.equals(original)).toBe(true);
  });

  it('can still derive, which is what a subscriber does', () => {
    const stored = unwrap(
      Provenance.fromWire(sequence('sub'), root().toJSON()),
    );

    expect(stored.derive('evt_9').requestId).toBe('sub_001');
    expect(stored.derive('evt_9').causationId).toBe('evt_9');
  });

  it('refuses a malformed record as Internal, not Invalid', () => {
    // A stored record that will not parse is a bug in whatever wrote it, not
    // user input.
    const mint = sequence();
    const bad: unknown[] = [
      null,
      'nope',
      {},
      { request_id: 'r', correlation_id: 'c' },
      {
        request_id: 'a b',
        correlation_id: 'c',
        actor: { kind: 'user', id: 'x' },
      },
      {
        request_id: 'r',
        correlation_id: 'c',
        actor: { kind: 'nobody', id: 'x' },
      },
      { request_id: 'r', correlation_id: 'c', actor: { kind: 'user', id: '' } },
    ];

    for (const wire of bad) {
      const result = Provenance.fromWire(mint, wire);
      expect(isErr(result), `expected ${JSON.stringify(wire)} refused`).toBe(
        true,
      );
      expect(isErr(result) && result.error.kind).toBe(Kind.Internal);
    }
  });

  it('does not restore traceparent, because it was never recorded', () => {
    const traced = root().withTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );

    expect(
      unwrap(Provenance.fromWire(sequence(), traced.toJSON())).traceparent,
    ).toBeUndefined();
  });
});

describe('identity', () => {
  it('compares by the of-record form, ignoring the id source', () => {
    expect(root().equals(root())).toBe(true);
    expect(root().equals(root().withTenant('acme'))).toBe(false);
  });

  it('cannot be counterfeited by a plain object', () => {
    expect(Provenance.is({ requestId: 'r', correlationId: 'c' })).toBe(false);
    expect(Provenance.is(root())).toBe(true);
  });
});

describe('the testkit', () => {
  it('defaults everything, so a test states only what it cares about', () => {
    const p = fakeProvenance();

    expect(p.requestId).toBe('req_000');
    expect(p.correlationId).toBe('req_000');
    expect(p.causationId).toBeUndefined();
    expect(String(p.actor)).toBe('anonymous:');
    expect(p.tenant).toBeUndefined();
  });

  it('is fixed, not random, so an assertion does not depend on the run', () => {
    expect(fakeProvenance().equals(fakeProvenance())).toBe(true);
  });

  it('overrides one field at a time', () => {
    const p = fakeProvenance({ correlationId: 'corr_x', tenant: 'acme' });

    expect(p.correlationId).toBe('corr_x');
    expect(p.tenant).toBe('acme');
    expect(p.requestId).toBe('req_000');
  });

  it('produces provenance that still derives', () => {
    // A builder that skipped the real constructor would produce something that
    // looks right and cannot be used.
    const child = fakeProvenance({ correlationId: 'corr_x' }).derive('evt_1');

    expect(child.correlationId).toBe('corr_x');
    expect(child.causationId).toBe('evt_1');
    expect(child.requestId).toBe('req_001');
  });
});
