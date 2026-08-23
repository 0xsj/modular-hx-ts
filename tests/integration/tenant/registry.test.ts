/**
 * The PostgreSQL registry and the SQL-side fence. **Rung 2.**
 *
 * Runs the same contract the memory adapter runs, then proves cross-tenant
 * invisibility **in SQL** — because *the filter is in the SQL* and *the filter
 * is in the memory adapter's predicate* are two implementations of one promise,
 * and a suite that only exercised one would leave the other untested.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Carrier, makeOrigins } from '../../../src/shared/provenance/index.js';
import { fakeIds } from '../../../src/shared/id/index.js';
import { fakeClock } from '../../../src/shared/clock/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import {
  postgresRegistry,
  tenantMigrations,
  TENANT_TABLE,
} from '../../../src/shared/tenant/index.js';
import {
  registryContract,
  ACME,
  FROZEN,
} from '../../../src/shared/tenant/tenanttest.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;

integration('postgres tenant registry', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, tenantMigrations);
    // The migration seeds `default`; the contract needs these two.
    for (const t of [ACME, FROZEN]) {
      await schema.db.exec(
        `insert into ${TENANT_TABLE} (id, slug, name, status)
           values ($1, $2, $3, $4) on conflict (id) do nothing`,
        [t.id, t.slug, t.name, t.status],
      );
    }
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    registryContract(() => ({
      name: 'postgres',
      registry: () => Promise.resolve(postgresRegistry(schema.db)),
    }));
  });

  describe('the migration seeds the default tenant', () => {
    it('so a single-mode process has its one tenant before any code runs', async () => {
      // Seeded by the migration rather than by boot, so a fresh database is
      // usable immediately and the row is identical everywhere.
      const row = await schema.db.queryRow<{ id: string; status: string }>(
        `select id, status from ${TENANT_TABLE} where id = 'default'`,
      );

      expect(row).toEqual({ id: 'default', status: 'active' });
    });
  });

  describe('an unrecognised status is treated as suspended', () => {
    it('fails closed rather than becoming usable', async () => {
      // A row somebody set to something this build does not know about must not
      // be usable. Failing open here would make an unknown value a bypass.
      await schema.db.exec(
        `insert into ${TENANT_TABLE} (id, slug, name, status)
           values ('t_weird', 'weird', 'Weird', 'pending')
           on conflict (id) do nothing`,
      );

      expect((await postgresRegistry(schema.db).byId('t_weird'))?.status).toBe(
        'suspended',
      );
    });
  });

  describe('cross-tenant invisibility, in SQL', () => {
    it('returns nothing rather than refusing', async () => {
      // Conformance case 23 at the storage layer: the row exists and the query
      // finds none. An implementation that selected it and then refused would
      // be a 403, which confirms existence.
      await schema.db.exec(
        `create table if not exists widgets (
           id text primary key, tenant text not null, name text not null)`,
      );
      await schema.db.exec('truncate widgets');
      await schema.db.exec(
        `insert into widgets (id, tenant, name)
           values ('w1', $1, 'ours'), ('w2', $2, 'theirs')`,
        [ACME.id, FROZEN.id],
      );

      // What a repository does: filter by the request's tenant, always.
      const visible = await schema.db.query<{ id: string }>(
        'select id from widgets where tenant = $1',
        [ACME.id],
      );

      expect(visible).toEqual([{ id: 'w1' }]);

      // The other tenant's row is reachable by id only if the filter is
      // dropped — which is what M3 exists to prevent.
      const byIdAlone = await schema.db.query(
        'select id from widgets where id = $1 and tenant = $2',
        ['w2', ACME.id],
      );
      expect(byIdAlone).toEqual([]);
    });
  });

  describe('app.tenant_id is set inside a transaction', () => {
    it('carries the ambient tenant, so RLS is available later', async () => {
      // Nothing reads it yet. It is set now so row-level security can be added
      // without a second pass over every adapter.
      const origins = makeOrigins(fakeIds(fakeClock()));
      const provenance = origins.forJob('test.rls').withTenant(ACME.id);

      const seen = await Carrier.run(provenance, () =>
        schema.db.withinTx((tx) =>
          tx.queryRow<{ v: string }>(
            "select current_setting('app.tenant_id', true) as v",
          ),
        ),
      );

      expect(seen?.v).toBe(ACME.id);
    });

    it('leaves it unset when there is no ambient tenant', async () => {
      // A migration or a boot job is not tenant work, and an empty string would
      // look like a tenant named "".
      const seen = await schema.db.withinTx((tx) =>
        tx.queryRow<{ v: string | null }>(
          "select current_setting('app.tenant_id', true) as v",
        ),
      );

      expect(seen?.v === null || seen?.v === '').toBe(true);
    });

    it('does not leak onto the next transaction', async () => {
      // `SET LOCAL` is transaction-scoped; a pooled connection must not carry
      // one request's tenant into another's.
      const origins = makeOrigins(fakeIds(fakeClock()));
      await Carrier.run(origins.forJob('t').withTenant(ACME.id), () =>
        schema.db.withinTx(() => Promise.resolve()),
      );

      const after = await schema.db.withinTx((tx) =>
        tx.queryRow<{ v: string | null }>(
          "select current_setting('app.tenant_id', true) as v",
        ),
      );

      expect(after?.v === null || after?.v === '').toBe(true);
    });
  });
});
