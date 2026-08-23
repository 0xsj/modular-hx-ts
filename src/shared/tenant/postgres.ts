/**
 * The PostgreSQL registry. **The real adapter.**
 *
 * Namespaced `tenant`, not a context: tenancy is infrastructure every context
 * is scoped by, and rule `M7` only requires that no two *contexts* share a
 * namespace.
 *
 * See `notes/patterns/tenant.md`.
 */

import { type DB, type MigrationSet } from '../postgres/index.js';
import { type Registry } from './registry.js';
import { Status, type Tenant } from './tenant.js';

export const TENANT_TABLE = 'tenants';

export const tenantMigrations: MigrationSet = [
  {
    context: 'tenant',
    name: '0001_tenants',
    sql: `
      create table ${TENANT_TABLE} (
        id         text        primary key,
        slug       text        not null unique,
        name       text        not null,
        status     text        not null default 'active',
        created_at timestamptz not null default now()
      );

      -- The seed a single-mode process depends on. Inserted by the migration
      -- rather than by boot, so a fresh database is usable before any code runs
      -- and so the row is identical everywhere.
      insert into ${TENANT_TABLE} (id, slug, name)
        values ('default', 'default', 'Default');
    `,
  },
];

interface Row {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
}

const toTenant = (row: Row): Tenant => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  // An unrecognised status is treated as suspended, not active. A row somebody
  // set to something this build does not know about must not be usable.
  status: row.status === Status.Active ? Status.Active : Status.Suspended,
});

export function postgresRegistry(db: DB): Registry {
  return {
    async byId(id) {
      const row = await db.queryRow<Row>(
        `select id, slug, name, status from ${TENANT_TABLE} where id = $1`,
        [id],
      );
      return row === undefined ? undefined : toTenant(row);
    },

    async bySlug(slug) {
      const row = await db.queryRow<Row>(
        `select id, slug, name, status from ${TENANT_TABLE} where slug = $1`,
        [slug],
      );
      return row === undefined ? undefined : toTenant(row);
    },

    async all() {
      const rows = await db.query<Row>(
        `select id, slug, name, status from ${TENANT_TABLE} order by id`,
      );
      return rows.map(toTenant);
    },
  };
}
