/**
 * One contract suite; both registry adapters pass it. **Test tooling** — `S3`.
 *
 * The cross-tenant cases are run against **both** adapters on purpose. *The
 * filter is in the SQL* and *the filter is in the memory adapter's predicate*
 * are two implementations of one promise, and a suite that only exercised one
 * of them would leave the other's version of invisibility untested.
 */

import { describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../errors/index.js';
import { isErr, unwrap } from '../result/index.js';
import { makeResolver, type Registry } from './registry.js';
import { Status, Tenancy, type Tenant } from './tenant.js';

export interface Subject {
  readonly name: string;
  /** A registry seeded with `acme` (active) and `frozen` (suspended). */
  readonly registry: () => Promise<Registry>;
}

export const ACME: Tenant = {
  id: 't_acme',
  slug: 'acme',
  name: 'Acme',
  status: Status.Active,
};

export const FROZEN: Tenant = {
  id: 't_frozen',
  slug: 'frozen',
  name: 'Frozen',
  status: Status.Suspended,
};

export function registryContract(subject: () => Subject): void {
  const registry = async (): Promise<Registry> => subject().registry();

  describe('lookup', () => {
    it('finds a tenant by id and by slug', async () => {
      const r = await registry();

      expect((await r.byId(ACME.id))?.slug).toBe('acme');
      expect((await r.bySlug('acme'))?.id).toBe(ACME.id);
    });

    it('returns undefined for one that does not exist', async () => {
      const r = await registry();

      expect(await r.byId('t_nope')).toBeUndefined();
      expect(await r.bySlug('nope')).toBeUndefined();
    });

    it('reports a suspended tenant’s status rather than hiding it', async () => {
      // Existence and usability are different questions. The *resolver*
      // decides what to do about status; the registry only reports.
      const r = await registry();

      expect((await r.byId(FROZEN.id))?.status).toBe(Status.Suspended);
    });
  });

  describe('resolution happens before authentication', () => {
    const resolve = async (
      header?: string,
      host?: string,
    ): ReturnType<ReturnType<typeof makeResolver>['resolve']> => {
      const resolver = makeResolver({
        mode: Tenancy.Multi,
        registry: await registry(),
        baseDomain: 'example.com',
      });
      return resolver.resolve({
        ...(header === undefined ? {} : { header }),
        ...(host === undefined ? {} : { host }),
      });
    };

    it('resolves from the x-tenant-id header', async () => {
      expect(unwrap(await resolve(ACME.id)).slug).toBe('acme');
      expect(unwrap(await resolve('acme')).id).toBe(ACME.id);
    });

    it('resolves from a host subdomain', async () => {
      expect(unwrap(await resolve(undefined, 'acme.example.com')).id).toBe(
        ACME.id,
      );
      expect(unwrap(await resolve(undefined, 'acme.example.com:8443')).id).toBe(
        ACME.id,
      );
    });

    it('is 404 for an unknown tenant', async () => {
      // Not 403: an unknown tenant must not be distinguishable from one that
      // exists and refused.
      const failed = await resolve('nope');
      expect(isErr(failed)).toBe(true);
      expect(kindOf(isErr(failed) ? failed.error : undefined)).toBe(
        Kind.NotFound,
      );
    });

    it('is 403 for a suspended tenant', async () => {
      // The caller reached a tenant it may legitimately know about; the refusal
      // is about state rather than existence.
      const failed = await resolve(FROZEN.id);

      expect(kindOf(isErr(failed) ? failed.error : undefined)).toBe(
        Kind.Forbidden,
      );
    });

    it('refuses a host that is not under the base domain', async () => {
      // An attacker-chosen Host must not resolve anywhere.
      const failed = await resolve(undefined, 'acme.attacker.test');

      expect(kindOf(isErr(failed) ? failed.error : undefined)).toBe(
        Kind.NotFound,
      );
    });

    it('refuses a multi-label subdomain', async () => {
      // `a.b.example.com` is not tenant `a.b`.
      const failed = await resolve(undefined, 'a.b.example.com');

      expect(isErr(failed)).toBe(true);
    });

    it('refuses a request carrying neither', async () => {
      expect(isErr(await resolve())).toBe(true);
    });
  });

  describe('single mode is byte-identical to no tenancy', () => {
    it('resolves without consulting the registry at all', async () => {
      // **Conformance case 21**, and the property that makes carrying this from
      // day one free. Not a registry hit that happens to return one row — no
      // call. A counting registry proves it.
      let calls = 0;
      const counted: Registry = {
        byId: async (id) => {
          calls += 1;
          return (await registry()).byId(id);
        },
        bySlug: async (slug) => {
          calls += 1;
          return (await registry()).bySlug(slug);
        },
        all: async () => (await registry()).all(),
      };

      const resolver = makeResolver({
        mode: Tenancy.Single,
        registry: counted,
      });

      const resolved = unwrap(await resolver.resolve({ header: 'anything' }));

      expect(calls).toBe(0);
      expect(resolved.id).toBe('default');
    });

    it('ignores a header that would resolve elsewhere in multi mode', async () => {
      // There is nothing for it to select. Validating it would be a behaviour a
      // build with no tenancy does not have.
      const resolver = makeResolver({
        mode: Tenancy.Single,
        registry: await registry(),
      });

      expect(unwrap(await resolver.resolve({ header: ACME.id })).id).toBe(
        'default',
      );
    });

    it('never fails, whatever arrives', async () => {
      const resolver = makeResolver({
        mode: Tenancy.Single,
        registry: await registry(),
      });

      for (const inbound of [
        {},
        { header: 'nope' },
        { host: 'attacker.test' },
        { header: FROZEN.id },
      ]) {
        expect(isErr(await resolver.resolve(inbound))).toBe(false);
      }
    });
  });
}
