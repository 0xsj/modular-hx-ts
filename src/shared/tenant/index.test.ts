import { describe, expect, it } from 'vitest';
import {
  compilePolicy,
  makeAuthorizer,
  Scope,
  subject as makeSubject,
  type Subject,
} from '../authz/index.js';
import { Kind, kindOf } from '../errors/index.js';
import { Actor } from '../provenance/index.js';
import { isErr, unwrap } from '../result/index.js';
import { fence, type Fenced } from './fence.js';
import { memoryRegistry } from './memory.js';
import { invisible, requireTenant, subdomainOf } from './registry.js';
import { registryContract, ACME, FROZEN } from './tenanttest.js';
import { DEFAULT_TENANT, Status, tenant } from './tenant.js';

const ADA = unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844'));

const who = (over: Partial<Subject> = {}): Subject =>
  makeSubject({ actor: ADA, roles: ['admin'], tenant: 't_acme', ...over });

describe('the memory adapter', () => {
  registryContract(() => ({
    name: 'memory',
    registry: () =>
      Promise.resolve(memoryRegistry([DEFAULT_TENANT, ACME, FROZEN])),
  }));
});

describe('the fence beats every grant', () => {
  // `admin` has unrestricted `user:list`. The fence must still stop it.
  const policy = unwrap(
    compilePolicy({ admin: [{ action: 'user:list', scope: Scope.Any }] }),
  );
  const fenced = makeAuthorizer(policy, { before: fence });
  const unfenced = makeAuthorizer(policy);

  const theirs: Fenced = { type: 'user', id: 'u9', tenant: 't_other' };
  const ours: Fenced = { type: 'user', id: 'u1', tenant: 't_acme' };

  it('denies an administrator a resource in another tenant', () => {
    // Conformance case 24. Without the fence this is allowed — the grant is
    // unrestricted — which is exactly the point.
    expect(unfenced.allow(who(), 'user:list', theirs).allowed).toBe(true);
    expect(fenced.allow(who(), 'user:list', theirs).allowed).toBe(false);
  });

  it('still allows the same action in the subject’s own tenant', () => {
    expect(fenced.allow(who(), 'user:list', ours).allowed).toBe(true);
  });

  it('cannot be out-granted, because it is not a grant', () => {
    // A fence that were merely the most powerful grant could be beaten by a
    // policy edit. There is no policy here that permits crossing it: the check
    // runs before any grant is consulted.
    const superuser = unwrap(
      compilePolicy({
        root: [
          { action: 'user:list', scope: Scope.Any },
          { action: 'user:delete', scope: Scope.Any },
          { action: 'audit:read', scope: Scope.Any },
        ],
      }),
    );
    const a = makeAuthorizer(superuser, { before: fence });

    expect(a.allow(who({ roles: ['root'] }), 'user:list', theirs).allowed).toBe(
      false,
    );
  });

  it('does not fence a resource that names no tenant', () => {
    // A pre-resource question — *may this subject list users at all?* — is not
    // a fence question, and denying it would break every list endpoint before
    // `reach` could narrow it.
    expect(fenced.allow(who(), 'user:list').allowed).toBe(true);
    expect(fenced.allow(who(), 'user:list', { type: 'user' }).allowed).toBe(
      true,
    );
  });
});

describe('a cross-tenant resource is invisible, not forbidden', () => {
  it('is NotFound, never Forbidden', () => {
    // **Conformance case 23**, and the one people get wrong because 403 feels
    // more honest. It is honest to the attacker: a 403 confirms the resource
    // exists, which turns any id into an oracle for what other tenants hold.
    const error = invisible('user');

    expect(kindOf(error)).toBe(Kind.NotFound);
    expect(kindOf(error)).not.toBe(Kind.Forbidden);
  });

  it('says nothing about what it did not find', () => {
    expect(invisible('user').message).toBe('no such user');
  });
});

describe('the accessor fails closed', () => {
  it('gives Internal when there is no tenant, never a default', () => {
    // A silent default here would be the whole module failing open at the one
    // place it must not.
    for (const absent of [undefined, '']) {
      const result = requireTenant(absent);
      expect(kindOf(isErr(result) ? result.error : undefined)).toBe(
        Kind.Internal,
      );
    }
  });

  it('passes a present tenant through', () => {
    expect(unwrap(requireTenant('t_acme'))).toBe('t_acme');
  });
});

describe('shapes', () => {
  it('takes a single-label subdomain under the base domain and nothing else', () => {
    expect(subdomainOf('acme.example.com', 'example.com')).toBe('acme');
    expect(subdomainOf('acme.example.com:8443', 'example.com')).toBe('acme');
    expect(subdomainOf('ACME.Example.com', 'example.com')).toBe('acme');
    // An attacker-chosen host must resolve nowhere.
    expect(subdomainOf('acme.attacker.test', 'example.com')).toBeUndefined();
    expect(subdomainOf('a.b.example.com', 'example.com')).toBeUndefined();
    expect(subdomainOf('example.com', 'example.com')).toBeUndefined();
  });

  it('requires a tenant id to satisfy the provenance id shape', () => {
    // PROVENANCE.md §7: it is L3's obligation to mint ids that satisfy a rule
    // owned by L1, because the id reaches hashed bytes.
    expect(isErr(tenant({ ...ACME, id: 'has spaces' }))).toBe(true);
    expect(isErr(tenant({ ...ACME, id: '' }))).toBe(true);
  });

  it('requires a slug to be a DNS label, because it reaches a hostname', () => {
    expect(isErr(tenant({ ...ACME, slug: 'Acme' }))).toBe(true);
    expect(isErr(tenant({ ...ACME, slug: '-acme' }))).toBe(true);
    expect(isErr(tenant({ ...ACME, slug: 'a'.repeat(64) }))).toBe(true);
    expect(isErr(tenant({ ...ACME, slug: 'acme-1' }))).toBe(false);
  });

  it('seeds a default tenant that is a real, active tenant', () => {
    // Not a null threaded through every call site — that is what keeps single
    // mode on the same code path as multi.
    expect(DEFAULT_TENANT.status).toBe(Status.Active);
    expect(isErr(tenant(DEFAULT_TENANT))).toBe(false);
  });
});
