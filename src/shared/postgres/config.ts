/**
 * How a pool is configured. **L2 substrate.**
 *
 * **`Config` is a struct, not an interface** (`../../../MODULES.md` §3). Nothing
 * swaps it, and making it swappable would be inversion for its own sake.
 *
 * **The DSN is a parameter.** This is the property §3 says must be designed in
 * from the first line, and the reason is `testx`: a test appends
 * `options=-csearch_path%3D<schema>` to get a schema of its own, and if this
 * module read the DSN from the environment or a global then every test would
 * share one schema, none of them could run in parallel, and the fix would be a
 * rewrite of the constructor rather than an addition. Only the composition root
 * reads the environment.
 *
 * See `notes/patterns/postgres.md`.
 */

import { type Millis, seconds } from '../clock/index.js';

export interface Config {
  /**
   * The connection string. **A parameter, never read from the environment
   * here** — see above, and note that a test's `search_path` rides on it.
   */
  readonly dsn: string;

  /** Ceiling on connections this process opens. */
  readonly maxConnections?: number;

  /**
   * How long any one statement may run before the server cancels it.
   *
   * PostgreSQL ships this **unlimited**, which is how a single bad query
   * exhausts a pool: every connection ends up waiting on it, and the process
   * stops serving anything at all. Migrations are exempt (`migrate.ts`);
   * nothing else is.
   */
  readonly statementTimeout?: Millis;

  /**
   * How long a statement waits to acquire a lock before giving up.
   *
   * Also unlimited by default. Waiting longer for a lock does not make the lock
   * arrive sooner — it makes the queue behind it longer, and a brief contention
   * spike becomes a pile-up. **Migrations are not exempt from this one**, on
   * purpose: a migration that cannot get its lock should fail fast and be
   * retried, not hold the deploy open while it blocks live traffic.
   */
  readonly lockTimeout?: Millis;

  /**
   * How long a transaction may sit idle before the server ends the session.
   *
   * Unlimited by default, and the most damaging of the three: an open
   * transaction holds its locks and pins the oldest snapshot, so one stalled
   * client blocks vacuum for the whole database.
   */
  readonly idleInTransactionTimeout?: Millis;

  /** How long to wait for a connection to be established. */
  readonly connectTimeout?: Millis;

  /**
   * What this process calls itself in `pg_stat_activity`.
   *
   * Free, and the difference between diagnosing a stuck query in one look and
   * diagnosing it by elimination.
   */
  readonly applicationName?: string;
}

/**
 * The guardrails, resolved.
 *
 * **All three are on by default**, which is the whole point — a blueprint whose
 * timeouts must be opted into ships the same outage every project ships.
 */
export interface Guardrails {
  readonly statementTimeout: Millis;
  readonly lockTimeout: Millis;
  readonly idleInTransactionTimeout: Millis;
}

export const DEFAULTS: Guardrails = {
  // Longer than any request should take, short enough that a runaway query is
  // cancelled before it has taken the pool with it.
  statementTimeout: seconds(15),
  // Deliberately the shortest: lock waits queue behind each other.
  lockTimeout: seconds(5),
  // Generous, because a legitimate transaction spanning a slow call exists;
  // bounded, because an abandoned one blocks vacuum forever.
  idleInTransactionTimeout: seconds(30),
};

export function guardrails(config: Config): Guardrails {
  return {
    statementTimeout: config.statementTimeout ?? DEFAULTS.statementTimeout,
    lockTimeout: config.lockTimeout ?? DEFAULTS.lockTimeout,
    idleInTransactionTimeout:
      config.idleInTransactionTimeout ?? DEFAULTS.idleInTransactionTimeout,
  };
}

/**
 * The guardrails as libpq startup options, merged into a DSN.
 *
 * **Not applied as `SET` statements on a `connect` handler.** That was the first
 * implementation and `pg` rejected it out loud: issuing a query from the
 * `connect` event races the borrower's own query on the same client, which
 * emits a deprecation warning today and **stops working in `pg@9`**. It also
 * had a quieter flaw — a connection handed out before its `SET` landed would
 * have run one statement with no timeout at all, which is exactly the statement
 * most likely to be the runaway.
 *
 * Startup options have neither problem: the server applies them before the
 * session accepts its first query, so there is no window and no ordering
 * assumption.
 *
 * **Merged, never overwritten.** `testx` puts `search_path` in the same
 * `options` parameter to get a schema per test; a module that assigned `options`
 * outright would silently clobber it, and every test would run against the
 * default schema while appearing to have its own.
 */
export function dsnWithGuardrails(dsn: string, rails: Guardrails): string {
  const settings = [
    `-c statement_timeout=${String(rails.statementTimeout)}`,
    `-c lock_timeout=${String(rails.lockTimeout)}`,
    `-c idle_in_transaction_session_timeout=${String(rails.idleInTransactionTimeout)}`,
  ].join(' ');

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // libpq also accepts a keyword/value form (`host=... port=...`), which is
    // not a URL. Returning it untouched is right: the alternative is a second
    // parser for a form this repository does not use, and a wrong guess here
    // silently disables every timeout.
    return dsn;
  }

  const existing = url.searchParams.get('options');
  url.searchParams.set(
    'options',
    existing === null || existing === '' ? settings : `${existing} ${settings}`,
  );
  return url.toString();
}
