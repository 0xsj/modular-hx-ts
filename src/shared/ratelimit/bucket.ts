/**
 * The token bucket, as arithmetic. **L4 edge, and pure.**
 *
 * Every adapter shares these four functions, so *what a bucket does* is decided
 * once and only *where the state lives* varies. That is what makes one contract
 * suite meaningful rather than two implementations that happen to agree today.
 *
 * **Refill is measured by elapsed duration, and the reading is monotonic —
 * rule `M13`.** A wall-clock step backward would otherwise stall every bucket
 * until real time caught up, and a step forward would hand out a full one. This
 * module is exactly the shape that bit `breaker` twice in this collection.
 *
 * The clamps here are the second half of that protection, and they matter for
 * the PostgreSQL adapter where no monotonic clock exists to inject — see
 * `postgres.ts`. `elapsed` is floored at zero, so time going backwards refills
 * nothing rather than draining the bucket; and the result is capped at
 * `capacity`, so time jumping forward grants at most one full bucket rather
 * than an unbounded one.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { type Millis, millis } from '../clock/index.js';

/**
 * How much, how often.
 *
 * `limit` is both the burst capacity and the sustained rate over `window`,
 * which is what makes `RateLimit-Limit` a single honest number rather than two
 * that need explaining.
 */
export interface Limit {
  /** Requests per `window`, and the bucket's capacity. */
  readonly limit: number;
  readonly window: Millis;
}

/** Tokens per millisecond. */
export function rate(limit: Limit): number {
  return limit.limit / limit.window;
}

/**
 * Tokens available after `elapsed` has passed.
 *
 * Total: there is no input it refuses, because a limiter that throws on a
 * strange clock reading is a limiter that fails the request it was meant to
 * merely count.
 */
export function refilled(
  tokens: number,
  elapsed: Millis,
  limit: Limit,
): number {
  // Floored at zero: a clock that went backwards refills nothing. Negative
  // elapsed would otherwise *drain* the bucket, turning a clock correction
  // into a throttle nobody asked for.
  const forward = Math.max(0, elapsed);
  // Capped at capacity: a clock that jumped forward grants one full bucket,
  // which is the token bucket's own bound rather than a special case.
  return Math.min(limit.limit, tokens + forward * rate(limit));
}

/**
 * How long until `tokens` reaches `needed`.
 *
 * Rounded **up** to whole milliseconds. A client told to wait 0 retries
 * immediately and is refused again, which is the loop `Retry-After` exists to
 * prevent.
 */
export function timeUntil(
  tokens: number,
  needed: number,
  limit: Limit,
): Millis {
  if (tokens >= needed) return millis(0);
  return millis(Math.ceil((needed - tokens) / rate(limit)));
}

/**
 * What the caller is told, and what the headers are built from.
 *
 * `resetAfter` is **how long until this caller's next request would be
 * admitted** — zero while tokens remain. That is a deliberate reading of
 * `RateLimit-Reset`, which the draft defines as time until the quota resets:
 * for a bucket that refills continuously there is no window boundary to point
 * at, and *time until you may go again* is the number a client can act on.
 *
 * It also makes `Retry-After` agreeing with `Reset` **structural**. On a 429
 * both headers are rendered from this one value, so they cannot drift — rather
 * than two code paths computing two numbers that are supposed to match.
 */
export interface Decision {
  readonly allowed: boolean;
  readonly limit: number;
  /** Whole tokens left. Fractional tokens are not a request anybody can make. */
  readonly remaining: number;
  readonly resetAfter: Millis;
}

/** Decide from a bucket's post-consume state. */
export function decide(
  allowed: boolean,
  tokens: number,
  limit: Limit,
): Decision {
  return {
    allowed,
    limit: limit.limit,
    remaining: Math.max(0, Math.floor(tokens)),
    // One token is the next request. Zero when there is already one waiting.
    resetAfter: timeUntil(tokens, 1, limit),
  };
}
