/**
 * Position 7. **L4 edge.**
 *
 * The last of the three slots `httpx` left named and empty, so the wiring is
 * one line and the module is the work.
 *
 * **This module and `idempotency` are the fail-open/fail-closed pair**, two
 * positions apart in the same chain, and a reader who meets both without the
 * reasoning will assume one is a bug. They are not symmetrical by accident:
 * `../../../RESILIENCE.md` §1 decides the default by *category*, and these two
 * are in different categories.
 *
 * | | store unreachable | why |
 * | --- | --- | --- |
 * | `idempotency` (9) | **503** | executing unclaimed double-applies a write the client asked to have protected |
 * | `ratelimit` (7) | **degrade and serve** | a broken throttle must not take the service down with it |
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { type Clock } from '../clock/index.js';
import { exhausted } from '../errors/index.js';
import {
  type Exchange,
  type Middleware,
  type Reporter,
  type Response,
} from '../edge/index.js';
import { type Limit } from './bucket.js';
import { rateLimitHeaders, retryAfter } from './headers.js';
import { type ProxyTrust, UNTRUSTED, callerKey } from './key.js';
import { memoryBucketStore, memoryBuckets } from './memory.js';
import { type Buckets } from './port.js';

/**
 * Endpoints an orchestrator polls.
 *
 * **Never limited.** Throttling liveness or readiness turns a traffic spike
 * into a rolling restart — the limiter causing the outage it was installed to
 * prevent, and doing it fastest exactly when the fleet is busiest.
 */
export const NEVER_LIMITED: readonly string[] = ['/healthz', '/readyz'];

export interface RateLimitOptions {
  readonly buckets: Buckets;
  readonly clock: Clock;
  readonly limit: Limit;

  /**
   * How many replicas share the limit.
   *
   * Used **only** to size the degraded fallback: when the shared store is
   * unreachable each process throttles at `limit / replicas`, so the fleet
   * still approximates the configured rate instead of multiplying it by the
   * replica count. Wrong by a factor of two is still a limit; absent is not.
   */
  readonly replicas?: number;

  /** Untrusted by default. See `key.ts`. */
  readonly trust?: ProxyTrust;

  /** Paths that are never limited. Defaults to liveness and readiness. */
  readonly exempt?: readonly string[];

  /**
   * Where the degraded fallback announces itself.
   *
   * Invariant `I9` requires a fail-open choice to be *logged when it fires*.
   * A limiter that silently stops being shared is a limiter nobody knows has
   * stopped being one, and the only symptom is a bill.
   */
  readonly reporter?: Reporter;
}

export function ratelimit(options: RateLimitOptions): Middleware {
  const { buckets, clock, limit, reporter } = options;
  const trust = options.trust ?? UNTRUSTED;
  const exempt = new Set(options.exempt ?? NEVER_LIMITED);

  /**
   * The degraded bucket, sized for one replica's share.
   *
   * Created once and kept, so it accumulates across an outage rather than
   * resetting on every request — a fallback rebuilt per request is a full
   * bucket per request, which is no limit at all wearing a limit's shape.
   */
  const replicas = Math.max(1, options.replicas ?? 1);
  const share: Limit = {
    limit: Math.max(1, Math.floor(limit.limit / replicas)),
    window: limit.window,
  };
  const fallback = memoryBuckets(memoryBucketStore(), clock);

  let degraded = false;

  return async (exchange: Exchange, next): Promise<Response> => {
    if (exempt.has(exchange.request.path)) return next(exchange);

    const key = callerKey(
      exchange.provenance,
      exchange.request.peer,
      exchange.request.headers,
      trust,
    );

    let decision;
    try {
      decision = await buckets.take(key, limit);
      if (degraded) {
        degraded = false;
        reporter?.info('rate limit store recovered; sharing again', {
          limit: limit.limit,
        });
      }
    } catch (error) {
      // **Fail open means degrade, not switch off.** `RESILIENCE.md` §1 puts
      // availability ahead of a broken throttle — but *the store is
      // unreachable* and *there is no limit* are different facts, and a store
      // outage is exactly when an unlimited edge is most dangerous: whatever
      // took the store down is usually load, and removing the limiter adds
      // more of it.
      //
      // A per-process bucket makes the limit approximate rather than absent,
      // and it self-heals: the next request tries the shared store again.
      if (!degraded) {
        degraded = true;
        reporter?.error('rate limit store unreachable; limiting per process', {
          share: share.limit,
          replicas,
          error: String(error),
        });
      }
      decision = await fallback.take(key, share);
    }

    // **On the exchange, not on the response.** Position 7 is below the problem
    // mapper at position 3, so a refusal leaves here as a throw and the code
    // after `next` never runs. Headers parked here survive that — see `edge`.
    //
    // Set before the refusal *and* before `next`, so they land on a 429, on a
    // 200, and on a 500 from three positions further down.
    Object.assign(exchange.responseHeaders, rateLimitHeaders(decision));

    if (!decision.allowed) {
      Object.assign(exchange.responseHeaders, {
        // Rendered from the same value as `RateLimit-Reset`, so the two cannot
        // disagree. See `headers.ts`.
        'retry-after': retryAfter(decision),
      });

      // Thrown, so conformance case 39's 429 is built by the same mapper as
      // every other error and carries the same request id. That is what
      // position 7 sitting below position 3 buys.
      throw exhausted('too many requests');
    }

    return next(exchange);
  };
}
