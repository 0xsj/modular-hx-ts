/**
 * The `RateLimit-*` headers. **L4 edge.**
 *
 * Conformance case 39 fixes the **separate-header** form:
 * `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, plus
 * `Retry-After` on a 429.
 *
 * A newer combined structured-field form exists — one `RateLimit` header
 * carrying a dictionary. If this repository adds it, it adds it **alongside**
 * and never instead: case 39 names these three, and a client written against
 * the case would stop working.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { type Decision } from './bucket.js';

/**
 * Seconds, rounded **up**, and never below one on a refusal.
 *
 * A `Retry-After: 0` is an instruction to retry immediately, which produces
 * another 429 and a client that hammers — the exact loop the header exists to
 * prevent. Rounding down has the same effect one millisecond later.
 */
export function seconds(millis: number): number {
  return Math.ceil(millis / 1_000);
}

/**
 * The three headers every response carries.
 *
 * **Every response, not only a 429.** A client that learns its budget only by
 * exceeding it has to exceed it to learn anything, which is a protocol that
 * rewards exactly the behaviour being limited.
 */
export function rateLimitHeaders(decision: Decision): Record<string, string> {
  return {
    'ratelimit-limit': String(decision.limit),
    'ratelimit-remaining': String(decision.remaining),
    'ratelimit-reset': String(seconds(decision.resetAfter)),
  };
}

/**
 * `Retry-After`, for a refusal.
 *
 * **Rendered from the same value as `RateLimit-Reset`**, so the two cannot
 * disagree. Two numbers that are supposed to match and are computed separately
 * eventually stop matching, and a client that has been burned by that once
 * learns to ignore both.
 */
export function retryAfter(decision: Decision): string {
  return String(Math.max(1, seconds(decision.resetAfter)));
}
