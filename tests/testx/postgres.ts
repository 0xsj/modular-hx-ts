/**
 * The integration-test harness: a schema of your own. **Test tooling.**
 *
 * `../../MODULES.md` §3: *`testx` is not a peer module and not a one-shot. It is
 * the integration-test harness, and it grows as substrate lands — Postgres now,
 * Redis with `cache`, SMTP with `mailer`.* It lives under `tests/` rather than
 * `src/shared/` for exactly that reason: it is not a layer module, it never
 * ships, and rule `S3` does not have to be argued with.
 *
 * **Schema per test, which is why the DSN had to be a parameter.** Each caller
 * gets a fresh PostgreSQL schema and a pool whose `search_path` points at it, so
 * suites run in parallel against one database without seeing each other's
 * tables. That works only because `postgres.connect` takes a DSN: this appends
 * `options=-csearch_path%3D<schema>` and changes nothing else.
 *
 * The guardrails ride on the connection separately, so they are not clobbered
 * by the `search_path` this puts in the DSN — see `postgres/config.ts`.
 *
 * Adding a second service is a **file beside this one**, not a redesign.
 */

import {
  connect,
  migrate,
  type MigrationSet,
  type Postgres,
} from '../../src/shared/postgres/index.js';

/**
 * Where the test database lives.
 *
 * The one place in the test tree that reads the environment, for the same
 * reason the composition root is the one place in `src/`: something has to know
 * the address, and everything else takes it as a parameter.
 *
 * Defaults to this repository's own compose stack — `../PORTS.md` base 15420,
 * Postgres at offset +0 — so `make test-integration` works with no `.env`.
 */
export function testDsn(): string {
  return (
    process.env['TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    'postgres://app:app@127.0.0.1:15420/app'
  );
}

export interface Schema {
  /** Connected to the schema, and pointed at it by `search_path`. */
  readonly db: Postgres;
  readonly name: string;
  /** Drops the schema and closes the pool. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * A PostgreSQL identifier that cannot be anything else.
 *
 * The name is built here rather than taken from a caller, but it is still
 * validated: this string is concatenated into DDL, where a parameter placeholder
 * is not allowed, and "we generated it" is the reasoning behind most injection
 * bugs that survive review.
 */
function assertIdentifier(name: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`unusable schema name: ${name}`);
  }
}

let counter = 0;

/**
 * Create a schema, connect to it, and optionally migrate into it.
 *
 * ```ts
 * const schema = await withSchema({ migrations: identity.migrations });
 * afterAll(() => schema.close());
 * ```
 */
export async function withSchema(
  options: { readonly migrations?: MigrationSet; readonly dsn?: string } = {},
): Promise<Schema> {
  const dsn = options.dsn ?? testDsn();

  // Process id and a counter: unique across parallel workers, and readable in
  // `pg_stat_activity` when something is stuck.
  counter += 1;
  const name = `test_${String(process.pid)}_${String(counter)}`;
  assertIdentifier(name);

  // A first connection with no `search_path`, only to create the schema.
  const admin = connect({ dsn, maxConnections: 1, applicationName: 'testx' });
  try {
    await admin.exec(`create schema if not exists ${name}`);
  } finally {
    await admin.close();
  }

  const db = connect({
    dsn: withSearchPath(dsn, name),
    maxConnections: 4,
    applicationName: `testx:${name}`,
  });

  if (options.migrations !== undefined) {
    await migrate(db, options.migrations);
  }

  let closed = false;
  return {
    db,
    name,
    async close() {
      if (closed) return;
      closed = true;
      await db.close();

      // Dropped through a separate connection: the pool pointed at the schema
      // cannot drop the schema it is sitting in.
      const dropper = connect({ dsn, maxConnections: 1 });
      try {
        await dropper.exec(`drop schema if exists ${name} cascade`);
      } finally {
        await dropper.close();
      }
    },
  };
}

/**
 * Append `search_path` to a DSN without disturbing what is already there.
 *
 * libpq takes it as a startup `options` string; `-c` sets one GUC. Any existing
 * `options` is preserved and this is appended, because a DSN that already
 * carried one was carrying it for a reason.
 */
export function withSearchPath(dsn: string, schema: string): string {
  const url = new URL(dsn);
  const existing = url.searchParams.get('options');
  const setting = `-c search_path=${schema}`;

  url.searchParams.set(
    'options',
    existing === null ? setting : `${existing} ${setting}`,
  );
  return url.toString();
}
