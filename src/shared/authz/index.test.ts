import { describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../errors/index.js';
import { Actor } from '../provenance/index.js';
import { isErr, unwrap } from '../result/index.js';
import {
  type Authorizer,
  type Command,
  type PolicySpec,
  type Subject,
  compilePolicy,
  denyAll,
  isAction,
  makeAuthorizer,
  refusal,
  Scope,
  subject,
} from './index.js';

const ADA = unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844'));
const GRACE = unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-000000000002'));

const SPEC: PolicySpec = {
  admin: [
    { action: 'user:list', scope: Scope.Any },
    { action: 'user:delete', scope: Scope.Any },
    { action: 'audit:read', scope: Scope.Any },
  ],
  member: [
    { action: 'user:list', scope: Scope.Own },
    { action: 'audit:read', scope: Scope.Own },
  ],
};

const KNOWN = ['user:list', 'user:delete', 'audit:read'];

function who(over: Partial<Subject> = {}): Subject {
  return subject({ actor: ADA, roles: ['member'], tenant: 't1', ...over });
}

function authorizer(spec: PolicySpec = SPEC): Authorizer {
  return makeAuthorizer(unwrap(compilePolicy(spec, KNOWN)));
}

describe('deny by default', () => {
  it('denies an action with no matching grant', () => {
    const a = authorizer();

    expect(a.allow(who(), 'user:delete')).toEqual({
      allowed: false,
      reason: 'no_grant',
    });
  });

  it('denies an unknown action rather than erroring', () => {
    // A typo in a call site must not be distinguishable from a permission the
    // caller genuinely lacks — an error would be an enumeration oracle.
    const a = authorizer();

    expect(a.allow(who(), 'nonsense:whatever').allowed).toBe(false);
    expect(a.reach(who(), 'nonsense:whatever')).toBe('denied');
  });

  it('denies a subject with no roles at all', () => {
    expect(authorizer().allow(who({ roles: [] }), 'user:list').allowed).toBe(
      false,
    );
  });

  it('an unwired authorizer is denyAll, not allowAll', () => {
    // **The structural half of deny-by-default.** A forgotten wire must show up
    // as 403s in the first test, never as an open admin endpoint. Invariant I9:
    // security controls fail closed.
    expect(denyAll.allow(who({ roles: ['admin'] }), 'user:delete')).toEqual({
      allowed: false,
      reason: 'no_policy',
    });
    expect(denyAll.reach(who({ roles: ['admin'] }), 'user:delete')).toBe(
      'denied',
    );
  });
});

describe('own versus any', () => {
  const mine = { type: 'audit', id: 'r1', ownerId: ADA.id };
  const theirs = { type: 'audit', id: 'r2', ownerId: GRACE.id };

  it('lets an own-scoped subject reach its own resource', () => {
    expect(authorizer().allow(who(), 'audit:read', mine)).toEqual({
      allowed: true,
      scope: Scope.Own,
    });
  });

  it('refuses an own-scoped subject somebody else’s resource', () => {
    expect(authorizer().allow(who(), 'audit:read', theirs)).toEqual({
      allowed: false,
      reason: 'not_owner',
    });
  });

  it('lets an any-scoped subject reach both', () => {
    const admin = who({ roles: ['admin'] });
    const a = authorizer();

    expect(a.allow(admin, 'audit:read', mine).allowed).toBe(true);
    expect(a.allow(admin, 'audit:read', theirs).allowed).toBe(true);
  });

  it('treats an unowned resource as unreachable by an own grant', () => {
    // Absent is not "mine". A resource nobody can claim cannot be claimed.
    expect(
      authorizer().allow(who(), 'audit:read', { type: 'audit', id: 'r3' }),
    ).toEqual({ allowed: false, reason: 'not_owner' });
  });

  it('gives a caller the tri-state before it builds a query', () => {
    // Every list endpoint needs this, which is why it lives here rather than
    // being written slightly differently in each context.
    const a = authorizer();

    expect(a.reach(who({ roles: ['admin'] }), 'audit:read')).toBe(
      'unrestricted',
    );
    expect(a.reach(who(), 'audit:read')).toBe('own');
    expect(a.reach(who(), 'user:delete')).toBe('denied');
  });

  it('takes the widest scope across several roles', () => {
    const both = who({ roles: ['member', 'admin'] });

    expect(authorizer().reach(both, 'audit:read')).toBe('unrestricted');
  });
});

describe('scopes only ever subtract', () => {
  it('narrows an owner’s grants rather than adding to them', () => {
    // A leaked key must not be able to exceed the human it belongs to.
    const key = who({ roles: ['admin'], scopes: ['user:list'] });
    const a = authorizer();

    expect(a.allow(key, 'user:list').allowed).toBe(true);
    // The owner has `user:delete`; the key does not carry it, so the key
    // cannot use it.
    expect(a.allow(key, 'user:delete').allowed).toBe(false);
  });

  it('cannot grant something the owner lacks', () => {
    // The inversion that matters: a scope naming an action the role has no
    // grant for must not create one.
    const key = who({ roles: ['member'], scopes: ['user:delete'] });

    expect(authorizer().allow(key, 'user:delete').allowed).toBe(false);
  });

  it('keeps the owner’s scope, not a wider one', () => {
    // `member` has audit:read at `own`. A key scoped to it stays `own`.
    const key = who({ roles: ['member'], scopes: ['audit:read'] });

    expect(authorizer().reach(key, 'audit:read')).toBe('own');
  });

  it('an empty scope list permits nothing', () => {
    // Treating "no scopes listed" as "no restriction" is how a locked-down key
    // becomes a superuser.
    const key = who({ roles: ['admin'], scopes: [] });

    expect(authorizer().allow(key, 'user:list').allowed).toBe(false);
  });

  it('is not the same as having no scopes at all', () => {
    // Absent means a person; empty means a key that may do nothing.
    expect(
      authorizer().allow(who({ roles: ['admin'] }), 'user:list').allowed,
    ).toBe(true);
  });
});

describe('policy is validated at boot', () => {
  it('rejects a grant naming an action no context declares', () => {
    // A typo would otherwise present as a permission that simply never
    // applies — the hardest kind to notice, because everyone assumes the
    // denial is intentional.
    const bad = compilePolicy(
      { admin: [{ action: 'user:lst', scope: Scope.Any }] },
      KNOWN,
    );

    expect(isErr(bad)).toBe(true);
    expect(String(isErr(bad) ? bad.error : '')).toContain('cannot be compiled');
  });

  it('rejects a malformed action name', () => {
    expect(
      isErr(
        compilePolicy({ admin: [{ action: 'UserList', scope: Scope.Any }] }),
      ),
    ).toBe(true);
  });

  it('reports every problem at once', () => {
    const bad = compilePolicy(
      {
        admin: [
          { action: 'nope', scope: Scope.Any },
          { action: 'user:unknown', scope: Scope.Any },
        ],
      },
      KNOWN,
    );

    expect(isErr(bad) ? bad.error.fields.length : 0).toBe(2);
  });

  it('takes the widest scope when a role grants both', () => {
    const policy = unwrap(
      compilePolicy(
        {
          admin: [
            { action: 'user:list', scope: Scope.Own },
            { action: 'user:list', scope: Scope.Any },
          ],
        },
        KNOWN,
      ),
    );

    expect(policy.scopeFor(['admin'], 'user:list')).toBe(Scope.Any);
  });

  it('compiles without a known-action list, for a repo with no contexts yet', () => {
    expect(isErr(compilePolicy(SPEC))).toBe(false);
  });
});

describe('the fence runs before grants', () => {
  it('denies regardless of what the policy says', () => {
    // `tenant` lands next and its fence beats every grant, including an
    // administrator's. Nothing here assumes grants are examined first, so that
    // arrives as a wiring change rather than a restructuring.
    const fenced = makeAuthorizer(unwrap(compilePolicy(SPEC, KNOWN)), {
      before: (s) => s.tenant === 't1',
    });
    const admin = who({ roles: ['admin'] });

    expect(fenced.allow(admin, 'user:delete').allowed).toBe(true);
    expect(
      fenced.allow(who({ roles: ['admin'], tenant: 't2' }), 'user:delete'),
    ).toEqual({ allowed: false, reason: 'out_of_scope' });
  });

  it('applies to reach as well, so a query is never built', () => {
    const fenced = makeAuthorizer(unwrap(compilePolicy(SPEC, KNOWN)), {
      before: () => false,
    });

    expect(fenced.reach(who({ roles: ['admin'] }), 'audit:read')).toBe(
      'denied',
    );
  });
});

describe('a use case cannot be declared without a Subject', () => {
  it('is expressible in the type system, not left to discipline', async () => {
    // TypeScript *can* state this, which was worth checking rather than
    // assuming — the note says so explicitly. `Command<In, Out>` puts the
    // subject in the signature, so omitting it is a compile error rather than
    // a review finding, exactly as `Record<keyof T, Level>` does for M9.
    const deleteUser: Command<{ id: string }, void> = (s, input) => {
      expect(s.tenant).toBe('t1');
      expect(input.id).toBe('u1');
      return Promise.resolve();
    };

    await deleteUser(who(), { id: 'u1' });

    // @ts-expect-error a command declared this way cannot omit its subject
    const broken: Command<{ id: string }, void> = (input: { id: string }) => {
      void input;
      return Promise.resolve();
    };
    void broken;
  });
});

describe('shapes', () => {
  it('accepts <resource>:<verb> and refuses anything else', () => {
    expect(isAction('user:list')).toBe(true);
    expect(isAction('audit_record:read')).toBe(true);
    for (const bad of [
      'User:list',
      'user',
      'user:',
      ':list',
      'user:list:all',
    ]) {
      expect(isAction(bad), bad).toBe(false);
    }
  });

  it('refuses a subject with no tenant', () => {
    expect(() => subject({ actor: ADA, roles: [], tenant: '' })).toThrow();
  });

  it('refuses a scope that is not an action', () => {
    expect(() =>
      subject({ actor: ADA, roles: [], tenant: 't1', scopes: ['nope'] }),
    ).toThrow();
  });

  it('turns a denial into a Forbidden that names no grant', () => {
    // Coarse on purpose: a denial explaining which grant was missing is an
    // enumeration oracle, and the caller can do nothing with the detail.
    const decision = authorizer().allow(who(), 'user:delete');
    const error = refusal('user:delete', decision);

    expect(kindOf(error)).toBe(Kind.Forbidden);
    expect(error.message).toBe('not permitted: user:delete');
  });
});
