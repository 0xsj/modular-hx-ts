/**
 * SQLSTATE → `Kind`. **L2 substrate.**
 *
 * `../../../MODULES.md` §3 makes this one of the four behaviours pinned by the
 * storage suite, and gives the reason: *a unique violation is `Conflict`
 * everywhere, or the same operation returns 409 in one blueprint and 500 in
 * another* — which conformance §4.1 checks and would fail.
 *
 * The mapping is deliberately **not** exhaustive. Every code not named here is
 * `Internal`, because a SQLSTATE nobody has thought about is a bug in the query
 * rather than a condition the caller can act on, and guessing a friendlier kind
 * would turn a defect into a 4xx somebody never investigates.
 *
 * See `notes/patterns/postgres.md`.
 */

import { AppError, Kind, wrap } from '../errors/index.js';

/**
 * The codes worth naming, by class.
 *
 * `isRetryable` is true for exactly `Unavailable` and `Timeout`, so a code
 * mapped to either of those is a code `retry` and `breaker` will act on. That
 * is the reason `40001` and `40P01` are `Unavailable` rather than `Conflict`:
 * a serialization failure and a deadlock are *supposed* to be retried, and
 * `Conflict` would tell the caller to stop.
 */
const CODES: Readonly<Record<string, Kind>> = {
  // 23 — integrity constraint violation
  '23505': Kind.Conflict, // unique_violation
  '23503': Kind.Conflict, // foreign_key_violation
  '23502': Kind.Invalid, // not_null_violation
  '23514': Kind.Invalid, // check_violation
  '23P01': Kind.Conflict, // exclusion_violation

  // 22 — data exception. The value was wrong before the database saw it.
  '22001': Kind.Invalid, // string_data_right_truncation
  '22003': Kind.Invalid, // numeric_value_out_of_range
  '22007': Kind.Invalid, // invalid_datetime_format
  '22P02': Kind.Invalid, // invalid_text_representation

  // 40 — transaction rollback. Retryable by design: the transaction did not
  // happen, and the same transaction attempted again may well succeed.
  '40001': Kind.Unavailable, // serialization_failure
  '40P01': Kind.Unavailable, // deadlock_detected

  // 55/57 — object not in prerequisite state, operator intervention.
  '55P03': Kind.Timeout, // lock_not_available — what `lock_timeout` raises
  '57014': Kind.Timeout, // query_canceled — what `statement_timeout` raises
  '57P01': Kind.Unavailable, // admin_shutdown
  '57P02': Kind.Unavailable, // crash_shutdown
  '57P03': Kind.Unavailable, // cannot_connect_now

  // 53 — insufficient resources. Not retryable-by-kind: hammering a pool that
  // is already full is how a bad minute becomes a bad hour.
  '53100': Kind.RateLimited, // disk_full
  '53200': Kind.RateLimited, // out_of_memory
  '53300': Kind.RateLimited, // too_many_connections

  // 25 — invalid transaction state.
  '25P02': Kind.Internal, // in_failed_sql_transaction — a bug in how it was driven
  // idle_in_transaction_session_timeout. FATAL: the server ends the *session*,
  // not just the statement, so the connection is gone with it.
  '25P03': Kind.Timeout,
};

/** Connection exceptions: the whole `08` class means the same thing. */
const CONNECTION_CLASS = '08';

/**
 * The `Kind` for a SQLSTATE, or `Internal` for anything unrecognised.
 *
 * Takes the code rather than the error so it is testable without constructing
 * a driver error, and so the storage suite can assert the table directly.
 */
export function kindForSqlState(code: string | undefined): Kind {
  if (code === undefined) return Kind.Internal;

  const known = CODES[code];
  if (known !== undefined) return known;

  // A connection that dropped is the same answer whichever way it dropped.
  if (code.startsWith(CONNECTION_CLASS)) return Kind.Unavailable;

  return Kind.Internal;
}

/** The SQLSTATE on a driver error, if it carries one. */
export function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Turn a driver error into an `AppError` carrying its `Kind`.
 *
 * Every path out of this module goes through here, so a caller never sees a raw
 * `pg` error and never has to know a SQLSTATE. The original is kept as the
 * cause, so `rootCause` still reaches it, and the code goes in `details` because
 * the SQLSTATE is the queryable half — the message is prose that differs between
 * server versions and locales.
 */
export function asAppError(error: unknown, what: string): AppError {
  const state = sqlStateOf(error);
  if (state === undefined) return wrap(error, what);

  const message = error instanceof Error ? error.message : String(error);
  return new AppError(kindForSqlState(state), `${what}: ${message}`, {
    cause: error,
    details: { sqlstate: state },
  });
}
