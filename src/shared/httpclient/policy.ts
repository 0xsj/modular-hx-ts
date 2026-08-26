/**
 * What may be retried, and what a status means. **L2 substrate.**
 *
 * Two decisions live here, and both are the kind that look obvious until they
 * are wrong in production.
 *
 * See `notes/patterns/httpclient.md`.
 */

import { type Millis, millis } from '../clock/index.js';
import { Kind } from '../errors/index.js';

/**
 * Methods safe to replay.
 *
 * RFC 9110's idempotent set, and the reasoning is not academic: **a bare `POST`
 * is not retried.** Replaying a charge because a response was slow is worse
 * than failing it — the caller can see a failure and decide, and cannot see a
 * duplicate until the customer does.
 *
 * `PATCH` is absent deliberately. It is not idempotent in general, and treating
 * it as such because it often is in practice is exactly the assumption that
 * fails on the endpoint that increments.
 */
const IDEMPOTENT = new Set([
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS',
  'TRACE',
]);

/** The caller asserting the upstream will deduplicate this request. */
export const IDEMPOTENCY_KEY = 'Idempotency-Key';

/**
 * May this request be sent again?
 *
 * By method, **or** because the caller supplied an `Idempotency-Key` — which is
 * the caller taking responsibility for a `POST` being replay-safe, which only
 * the caller can know.
 */
export function isReplayable(method: string, headers: Headers): boolean {
  return IDEMPOTENT.has(method.toUpperCase()) || headers.has(IDEMPOTENCY_KEY);
}

/**
 * HTTP status to `Kind`.
 *
 * `429` is `Exhausted` rather than `Unavailable`, which matters twice: it is
 * the honest kind, and it keeps rate limiting distinguishable from an outage in
 * a dashboard that groups by `err_kind`.
 */
export function kindForStatus(status: number): Kind {
  if (status >= 500) return Kind.Unavailable;

  switch (status) {
    case 400:
    case 405:
    case 409:
    case 415:
    case 422:
      return Kind.Invalid;
    case 401:
      return Kind.Unauthenticated;
    case 403:
      return Kind.Forbidden;
    case 404:
    case 410:
      return Kind.NotFound;
    case 408:
      return Kind.Timeout;
    case 429:
      return Kind.RateLimited;
    default:
      return status >= 400 ? Kind.Invalid : Kind.Internal;
  }
}

/**
 * Should a failure of this kind be retried?
 *
 * Narrower than `errors.isRetryable`, and deliberately so. That function is
 * about whether a failure is transient in general; this is about whether
 * sending the same HTTP request again could plausibly succeed.
 *
 * `Exhausted` is included here and excluded there: a rate limit is exactly the
 * thing a `Retry-After` tells you to wait out, and refusing to retry it would
 * make every 429 a caller-visible failure.
 */
export function isWorthRepeating(kind: Kind): boolean {
  return (
    kind === Kind.Unavailable ||
    kind === Kind.Timeout ||
    kind === Kind.RateLimited
  );
}

/**
 * Does this failure count against the circuit?
 *
 * **Only unreachable-or-5xx.** A 4xx means the endpoint is **up** and rejecting
 * you, and opening a circuit on it removes a working dependency because
 * somebody typed a bad id. A 404 storm from one broken caller would otherwise
 * take the upstream out for everybody.
 *
 * `429` is excluded for the same reason with a sharper edge: being rate limited
 * is the upstream working correctly, and tripping a breaker on it converts a
 * throttle into an outage.
 */
export function countsAgainstCircuit(kind: Kind): boolean {
  return kind === Kind.Unavailable || kind === Kind.Timeout;
}

/**
 * `Retry-After`, in either of its two forms.
 *
 * Delta-seconds or an HTTP-date (RFC 9110 §10.2.3). A server that says how long
 * to wait knows something the client does not, so this wins over local backoff
 * whenever it is present and sane.
 */
export function retryAfter(
  headers: Headers,
  now: Date,
  cap: Millis,
): Millis | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;

  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return millis(Math.min(seconds * 1000, cap));
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;

  // A date in the past means "now". A hostile or broken upstream naming a date
  // next year must not park a worker until then, which is what `cap` is for.
  return millis(Math.min(Math.max(0, at - now.getTime()), cap));
}
