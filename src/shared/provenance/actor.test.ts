import { describe, expect, expectTypeOf, it } from 'vitest';
import { Kind } from '../errors/index.js';
import { isErr, unwrap } from '../result/index.js';
import { Actor, ActorKind, type ActorWire } from './actor.js';

const USER_ID = '01a024c7-d2d6-7e71-8c87-e344e27ef844';

describe('ActorKind', () => {
  it('is exactly four values', () => {
    // Closed because the set is canonicalized into signed bytes. Growth happens
    // in the id path, where it changes no shape.
    expect(Object.values(ActorKind)).toEqual([
      'user',
      'service',
      'system',
      'anonymous',
    ]);
  });
});

describe('constructors', () => {
  it('builds each kind', () => {
    expect(String(unwrap(Actor.user(USER_ID)))).toBe(`user:${USER_ID}`);
    expect(String(unwrap(Actor.service('webhooks')))).toBe('service:webhooks');
    expect(String(unwrap(Actor.system('jobs/identity.purge')))).toBe(
      'system:jobs/identity.purge',
    );
    expect(String(Actor.anonymous())).toBe('anonymous:');
  });

  it('accepts the system vocabulary the specification names', () => {
    for (const path of ['jobs/identity.purge', 'migrate', 'boot', 'replay']) {
      expect(unwrap(Actor.system(path)).id).toBe(path);
    }
  });

  it('rejects an id outside the charset', () => {
    // Quotes, backslashes, angle brackets and whitespace are the log-injection
    // and header-echo surface.
    for (const id of ['a b', 'a"b', 'a\\b', '<script>', 'a\nb', 'café']) {
      expect(isErr(Actor.user(id)), `expected ${id} to be refused`).toBe(true);
    }
  });

  it('rejects an empty or oversized id', () => {
    expect(isErr(Actor.user(''))).toBe(true);
    expect(isErr(Actor.service('x'.repeat(129)))).toBe(true);
    expect(unwrap(Actor.service('x'.repeat(128))).id).toHaveLength(128);
  });

  it('refuses to give an anonymous actor an identity', () => {
    // `anonymous:someone` is a contradiction, and it would put an
    // unauthenticated identifier where an authenticated one is expected.
    const parsed = Actor.parse('anonymous:someone');

    expect(isErr(parsed)).toBe(true);
    expect(isErr(parsed) && parsed.error.kind).toBe(Kind.Invalid);
    expect(isErr(parsed) && parsed.error.message).toBe(
      'an anonymous actor has no id',
    );
  });
});

describe('parse', () => {
  it('round-trips every kind', () => {
    const actors = [
      unwrap(Actor.user(USER_ID)),
      unwrap(Actor.service('webhooks')),
      unwrap(Actor.system('jobs/identity.purge')),
      Actor.anonymous(),
    ];

    for (const actor of actors) {
      expect(unwrap(Actor.parse(String(actor))).equals(actor)).toBe(true);
    }
  });

  it('splits on the first colon, so an id may contain colons', () => {
    // A peer's opaque id is not ours to constrain beyond the charset.
    const actor = unwrap(Actor.parse('service:eu-west:billing:v2'));

    expect(actor.kind).toBe(ActorKind.Service);
    expect(actor.id).toBe('eu-west:billing:v2');
  });

  it('rejects what is not an actor', () => {
    for (const value of ['', 'user', 'nobody:1', 'USER:1', ':1']) {
      expect(isErr(Actor.parse(value)), `expected ${value} refused`).toBe(true);
    }
  });
});

describe('serialization', () => {
  it('omits on_behalf_of when absent, never null', () => {
    // §6: under RFC 8785 an absent key and a null value are different documents
    // with different digests. This is where cross-language parity is won or
    // lost, and it is lost silently.
    const wire = unwrap(Actor.user(USER_ID)).toJSON();

    expect(wire).toEqual({ kind: 'user', id: USER_ID });
    expect('on_behalf_of' in wire).toBe(false);
    expect(JSON.stringify(wire)).toBe(`{"kind":"user","id":"${USER_ID}"}`);
  });

  it('uses the snake_case keys that get hashed', () => {
    const agent = unwrap(Actor.service('support'));
    const wire = agent.actingFor(unwrap(Actor.user(USER_ID))).toJSON();

    expect(wire).toEqual({
      kind: 'service',
      id: 'support',
      on_behalf_of: { kind: 'user', id: USER_ID },
    });
  });

  it('serializes correctly even when nobody asked it to', () => {
    // Fields are private, so a careless JSON.stringify would yield {} without
    // toJSON. It yields the canonical form instead.
    const actor = unwrap(Actor.system('boot'));

    expect(JSON.parse(JSON.stringify(actor)) as ActorWire).toEqual({
      kind: 'system',
      id: 'boot',
    });
  });
});

describe('delegation', () => {
  it('returns a new actor rather than mutating', () => {
    const agent = unwrap(Actor.service('support'));
    const delegating = agent.actingFor(unwrap(Actor.user(USER_ID)));

    expect(agent.onBehalfOf).toBeUndefined();
    expect(delegating.onBehalfOf?.id).toBe(USER_ID);
    expect(delegating).not.toBe(agent);
  });

  it('keeps both principals, which is why the field exists now', () => {
    // MODULES.md puts both principals on provenance for impersonation. Adding
    // the field after the first signature would change every canonical form.
    const wire = unwrap(Actor.service('support'))
      .actingFor(unwrap(Actor.user(USER_ID)))
      .toJSON();

    expect(wire.id).toBe('support');
    expect(wire.on_behalf_of?.id).toBe(USER_ID);
  });
});

describe('identity', () => {
  it('compares by value', () => {
    expect(
      unwrap(Actor.user(USER_ID)).equals(unwrap(Actor.user(USER_ID))),
    ).toBe(true);
    expect(unwrap(Actor.user(USER_ID)).equals(Actor.anonymous())).toBe(false);
  });

  it('distinguishes delegation', () => {
    const agent = unwrap(Actor.service('support'));

    expect(agent.equals(agent.actingFor(Actor.anonymous()))).toBe(false);
  });

  it('cannot be counterfeited by a plain object', () => {
    // The private fields are the guarantee: a shape that looks like an actor
    // is not one, so nothing can skip validation by writing a literal.
    const impostor = { kind: 'user', id: USER_ID };

    expect(Actor.is(impostor)).toBe(false);
    expect(Actor.is(unwrap(Actor.user(USER_ID)))).toBe(true);
    expectTypeOf<typeof impostor>().not.toExtend<Actor>();
  });
});
