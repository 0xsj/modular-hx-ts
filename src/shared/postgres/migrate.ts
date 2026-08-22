/**
 * Migrations: forward-only, checksummed, namespaced, serialised. **L2.**
 *
 * **A tool the composition root runs, not a dependency a use case holds**
 * (`../../../MODULES.md` §3) — which is why this exports a function rather than
 * an interface, and why nothing here is swappable.
 *
 * **It takes a pool and a set.** The second property §3 says must be designed
 * in from the first line: a migrator that found its own connection could not be
 * pointed anywhere, so a test could not migrate into its own schema and
 * `testx`'s whole approach would be impossible to add later.
 *
 * **No down migrations.** The rollback story is a *new forward migration*, and
 * a breaking change is made by expand/contract — add, deploy, backfill, and
 * contract in a later release. A down migration is a plan written before the
 * failure, tested never, and run in the one situation where being wrong is
 * unrecoverable.
 *
 * See `notes/patterns/postgres.md`.
 */

import { invariant } from '../assert/index.js';
import { digestOfBytes } from '../digest/index.js';
import { conflict, wrap } from '../errors/index.js';
import { type DB } from './db.js';
import { dbOver, type Postgres } from './pool.js';

export interface Migration {
  /**
   * The context that owns it — `identity`, `audit`, `orgs`.
   *
   * Namespacing is per context so two contexts can both have an `0001`, and so
   * a context's migrations can be read as one sequence without the others
   * interleaved.
   */
  readonly context: string;
  /** `0001_create_users`. The numeric prefix is what orders it. */
  readonly name: string;
  readonly sql: string;
}

export type MigrationSet = readonly Migration[];

export interface Applied {
  readonly context: string;
  readonly name: string;
}

export interface Report {
  readonly applied: readonly Applied[];
  readonly alreadyApplied: number;
}

/**
 * One fixed key, so every instance of every process contends for the same lock.
 *
 * Arbitrary but permanent: changing it would let an old and a new deploy
 * migrate concurrently exactly once, which is the failure the lock exists to
 * prevent.
 */
const LOCK_KEY = 4_155_262_001;

const TABLE = 'schema_migrations';

/** `sha256:…` over the migration's bytes — the same digest form as everywhere. */
export function checksum(sql: string): string {
  return digestOfBytes(new TextEncoder().encode(sql));
}

/**
 * A deterministic order every instance agrees on.
 *
 * By context, then by name — so the numeric prefix does the ordering within a
 * context, and two processes given the same set apply it identically.
 */
function ordered(set: MigrationSet): MigrationSet {
  return [...set].sort((a, b) =>
    a.context === b.context
      ? a.name.localeCompare(b.name)
      : a.context.localeCompare(b.context),
  );
}

function validate(set: MigrationSet): void {
  const seen = new Set<string>();
  for (const migration of set) {
    invariant(migration.context !== '', 'a migration names its context');
    invariant(migration.name !== '', 'a migration is named');
    invariant(migration.sql.trim() !== '', `${migration.name} is empty`);

    const id = `${migration.context}/${migration.name}`;
    invariant(!seen.has(id), `a migration is registered once: ${id}`);
    seen.add(id);
  }
}

/**
 * Apply every migration in the set that has not been applied.
 *
 * Runs inside **one transaction** holding a transaction-scoped advisory lock,
 * so N instances starting together serialise rather than race — the second one
 * waits, then finds nothing to do. PostgreSQL's DDL is transactional, so a
 * failure part-way leaves the database exactly as it was.
 */
export async function migrate(
  postgres: Postgres,
  set: MigrationSet,
): Promise<Report> {
  validate(set);
  const pending = ordered(set);

  const client = await postgres.pool.connect();
  try {
    await client.query('BEGIN');

    // Exempt from the statement budget, and **only** that one. A migration
    // legitimately takes longer than a request; a migration that cannot get its
    // lock should still fail fast rather than hold the deploy open while it
    // blocks live traffic. `SET LOCAL` is transaction-scoped, so nothing leaks
    // back onto the pooled connection.
    await client.query('SET LOCAL statement_timeout = 0');

    // Serialises concurrent deploys. Transaction-scoped, so it is released by
    // COMMIT or ROLLBACK and cannot be leaked by a process that dies holding it.
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);

    // The same `DB` the pool hands out, over the connection holding the lock —
    // so a migration failure carries its SQLSTATE's `Kind` exactly as a query
    // failure does.
    const db: DB = dbOver(client);

    await db.exec(`
      create table if not exists ${TABLE} (
        context    text        not null,
        name       text        not null,
        checksum   text        not null,
        applied_at timestamptz not null default now(),
        primary key (context, name)
      )
    `);

    const already = await db.query<{
      context: string;
      name: string;
      checksum: string;
    }>(`select context, name, checksum from ${TABLE}`);

    const byId = new Map(
      already.map((row) => [`${row.context}/${row.name}`, row.checksum]),
    );

    const applied: Applied[] = [];

    for (const migration of pending) {
      const id = `${migration.context}/${migration.name}`;
      const sum = checksum(migration.sql);
      const recorded = byId.get(id);

      if (recorded !== undefined) {
        // The checksum is the whole reason to record one. An applied migration
        // that has been edited means the database and the repository disagree
        // about what was run, and every later assumption is unfounded.
        if (recorded !== sum) {
          throw conflict(
            `${id} has been modified since it was applied — migrations are forward-only, so add a new one`,
            { details: { applied: recorded, found: sum } },
          );
        }
        continue;
      }

      try {
        await db.exec(migration.sql);
      } catch (error) {
        // Wrapped, not replaced: the SQLSTATE's `Kind` is the useful half, and
        // `42601` (syntax error) and `23505` are very different failures.
        throw wrap(error, `${id} failed`);
      }

      await db.exec(
        `insert into ${TABLE} (context, name, checksum) values ($1, $2, $3)`,
        [migration.context, migration.name, sum],
      );
      applied.push({ context: migration.context, name: migration.name });
    }

    await client.query('COMMIT');
    return { applied, alreadyApplied: byId.size };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
