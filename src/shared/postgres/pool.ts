/**
 * The pool, and the transaction. **L2 substrate.**
 *
 * **The pool is concrete** (`../../../MODULES.md` §3): nothing swaps it, and
 * `postgres` is not an interface. Generic-over-dialects costs a great deal and
 * buys nothing here — the memory-versus-real swap already works without it,
 * because `STORAGE=memory` does not use this module at all.
 *
 * What *is* an interface is `DB`, and the reason this file matters is that
 * **both the pool and a transaction implement it**. A repository handed either
 * one behaves identically and cannot tell which it has.
 *
 * See `notes/patterns/postgres.md`.
 */

import pg from 'pg';
import { AppError, internal } from '../errors/index.js';
import { type Config, dsnWithGuardrails, guardrails } from './config.js';
import { type DB, type Row } from './db.js';
import { asAppError } from './sqlstate.js';

/**
 * `DB` over anything that can run a query: a pooled client, or the pool.
 *
 * Exported because `migrate` needs the same thing over a connection it holds
 * itself, and a second copy would be a second place for SQLSTATE translation to
 * be forgotten.
 */
export function dbOver(runner: pg.Pool | pg.PoolClient): DB {
  const run = async (
    sql: string,
    params: readonly unknown[] | undefined,
  ): Promise<pg.QueryResult> => {
    try {
      return await runner.query(sql, params === undefined ? [] : [...params]);
    } catch (error) {
      throw asAppError(error, 'query failed');
    }
  };

  return {
    query: async <T = Row>(sql: string, params?: readonly unknown[]) =>
      (await run(sql, params)).rows as T[],

    queryRow: async <T = Row>(sql: string, params?: readonly unknown[]) => {
      // The first row, and the rest are ignored rather than refused: `limit 1`
      // belongs in the caller's SQL, and erroring here would make a perfectly
      // reasonable "any of these will do" query fail.
      const [row] = (await run(sql, params)).rows as T[];
      return row;
    },

    exec: async (sql: string, params?: readonly unknown[]) =>
      (await run(sql, params)).rowCount ?? 0,
  };
}

export interface Postgres extends DB {
  /**
   * Run `fn` inside a transaction, committing if it returns and rolling back if
   * it throws.
   *
   * The `DB` handed to `fn` **is the transaction**. A repository constructed
   * with it writes inside the transaction without knowing one exists, which is
   * the dual satisfaction `DB` is shaped for.
   *
   * **Rejected: carrying the transaction ambiently** in an `AsyncLocalStorage`,
   * the way `provenance` is carried. The reasoning is the one
   * `../../../PROVENANCE.md` §3 gives for `authz`: nothing branches on
   * provenance, so a missing one only degrades observability — but a repository
   * that *missed* an ambient transaction would write outside it and report
   * success, which is silent data loss. Explicit passing makes that
   * impossible. The `Transactor` interface an application layer declares can be
   * satisfied by this method as it stands.
   */
  withinTx<T>(fn: (tx: DB) => Promise<T>): Promise<T>;

  /** Liveness for `health`. Runs one trivial query; no state. */
  ping(): Promise<void>;

  close(): Promise<void>;

  /** For `testx` and for `migrate`, which need a connection they control. */
  readonly pool: pg.Pool;
}

export function connect(config: Config): Postgres {
  // The guardrails ride on the connection string as startup options, so the
  // server applies them before the session accepts a query. See `config.ts` for
  // why this is not a `SET` on a connect handler.
  const pool = new pg.Pool({
    connectionString: dsnWithGuardrails(config.dsn, guardrails(config)),
    ...(config.maxConnections === undefined
      ? {}
      : { max: config.maxConnections }),
    ...(config.connectTimeout === undefined
      ? {}
      : { connectionTimeoutMillis: config.connectTimeout }),
    ...(config.applicationName === undefined
      ? {}
      : { application_name: config.applicationName }),
  });

  // A pool with no error listener crashes the process when an idle backend
  // dies — which happens on every database restart.
  pool.on('error', () => undefined);

  const db = dbOver(pool);

  return {
    ...db,

    async withinTx<T>(fn: (tx: DB) => Promise<T>): Promise<T> {
      const client = await pool.connect().catch((error: unknown) => {
        throw asAppError(error, 'could not acquire a connection');
      });

      // A checked-out client that dies mid-transaction emits `error` on
      // *itself*, not on the pool — and with no listener that is an unhandled
      // exception which takes the process down. It is not hypothetical: an
      // `idle_in_transaction_session_timeout` is FATAL, so the session the
      // guardrail protects the database from is exactly the one that triggers
      // it. The pool's own handler covers idle clients and does not cover this.
      //
      // **The first error is kept, not the last.** A dying connection emits
      // twice: `25P03` carrying the SQLSTATE, then a code-less "Connection
      // terminated unexpectedly". Keeping the latest overwrites the cause with
      // its own consequence, and the caller gets `Internal` for something that
      // was plainly a timeout.
      let died: unknown;
      const onError = (error: unknown): void => {
        died ??= error;
      };
      client.on('error', onError);

      try {
        await client.query('BEGIN');
        const result = await fn(dbOver(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // Rolling back can itself fail — a dropped connection, a session the
        // server already ended. The original failure is the one worth
        // reporting, so this one is swallowed deliberately.
        await client.query('ROLLBACK').catch(() => undefined);

        // If the connection died, that is the real cause and the query error is
        // just the symptom of writing to a closed socket.
        const cause = died ?? error;
        throw cause instanceof AppError
          ? cause
          : asAppError(cause, 'transaction failed');
      } finally {
        client.off('error', onError);
        // Released *with* the error when the connection died, so the pool
        // discards it instead of handing a dead socket to the next caller.
        client.release(died === undefined ? undefined : true);
      }
    },

    async ping(): Promise<void> {
      await db.query('select 1');
    },

    async close(): Promise<void> {
      try {
        await pool.end();
      } catch (error) {
        throw internal(`could not close the pool: ${String(error)}`);
      }
    },

    pool,
  };
}

// --- the Transactor shape, as documentation and as a tripwire --------------

/**
 * What a use case depends on — **declared here for documentation only**.
 *
 * `../../../MODULES.md` §3 is not negotiable about this: `Transactor` is
 * **consumer-declared in `app/`**, because an application layer that imported
 * `postgres` in order to say *"these writes are atomic"* has inverted nothing.
 * The use case knows it needs atomicity; it must not know what provides it.
 *
 * So this is **deliberately not re-exported from `index.ts`**. An application
 * layer declares its own two-line copy. If you find yourself importing this,
 * the import is the bug.
 *
 * What it is for is the assertion below.
 */
export interface Transactor {
  withinTx<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
}

/** Fails to compile unless `T` is `true`. */
type Assert<T extends true> = T;

/**
 * **The pool satisfies `Transactor`, checked at compile time.**
 *
 * Consumer-declared interfaces have one failure mode, and it is quiet: every
 * consumer declares its copy against the shape as it was, and a drift in
 * `withinTx`'s signature breaks each of them separately, later, far from the
 * change that caused it. This line moves that break **here** — the module that
 * did the drifting fails to build, before anything downstream sees it.
 *
 * Erased entirely by the compiler; it costs nothing at runtime.
 */
export type PoolSatisfiesTransactor = Assert<
  Postgres extends Transactor ? true : false
>;
