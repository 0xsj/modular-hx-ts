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
import { callerKey, ignoredForwarding } from './key.js';
import { type ProxyTrust } from './trust.js';
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

/** One line per this many ignored forwarding headers. */
const IGNORED_SAMPLE = 100;

export interface RateLimitOptions {
  readonly buckets: Buckets;
  readonly clock: Clock;
  readonly limit: Limit;

  /**
   * The rate one process allows while the shared store is unreachable.
   *
   * **Configured, never derived from a replica count.** This was `replicas`,
   * and the fallback throttled at `limit / replicas` so the fleet would still
   * approximate the configured rate. `MODULES.md` §5 rejects that shape and the
   * reason is not the arithmetic: a process must not be told its own fleet
   * size. It cannot verify the number, the orchestrator already owns it, and it
   * goes stale in silence — scale four replicas to twelve without editing the
   * config and each of the twelve admits a quarter of the limit, which is three
   * times the limit, discovered by a customer.
   *
   * **It defaults to the full limit, and that is stated rather than
   * disguised.** During an outage N replicas then admit N×limit collectively.
   * A share calculation would imply the aggregate is preserved; the thing the
   * outage took away *is* the coordination that made an aggregate meaningful.
   * Per-process limiting still stops one caller hammering one replica, which is
   * exactly what *approximate rather than absent* buys — and an operator who
   * wants tighter behaviour sets the number, usually more conservatively than
   * any share would allow, since a store outage tends to arrive with load.
   */
  readonly degradedLimit?: Limit;

  /**
   * Which proxies may set a forwarding header. **No default: see `key.ts`.**
   *
   * Required rather than optional, because both defaults are wrong in the same
   * way and `none` is a legal explicit value.
   */
  readonly trust: ProxyTrust;

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
  const { buckets, clock, limit, reporter, trust } = options;
  const exempt = new Set(options.exempt ?? NEVER_LIMITED);

  /**
   * The degraded bucket.
   *
   * Created once and kept, so it accumulates across an outage rather than
   * resetting on every request — a fallback rebuilt per request is a full
   * bucket per request, which is no limit at all wearing a limit's shape.
   */
  const degradedLimit: Limit = options.degradedLimit ?? limit;
  const fallback = memoryBuckets(memoryBucketStore());

  let degraded = false;
  /** How many ignored forwarding headers since the last line. */
  let ignored = 0;

  return async (exchange: Exchange, next): Promise<Response> => {
    if (exempt.has(exchange.request.path)) return next(exchange);

    const key = callerKey(
      exchange.provenance,
      exchange.request.peer,
      exchange.request.headers,
      trust,
    );

    // **Sampled, not per request.** A forwarding header from an untrusted peer
    // is ignored, and silence about it looks like a bug — after which the
    // obvious fix somebody reaches for is to trust it unconditionally. Every
    // request behind a misconfigured proxy carries one, so per-request logging
    // would bury the line it is trying to make visible.
    ignored += ignoredForwarding(
      exchange.request.peer,
      exchange.request.headers,
      trust,
    )
      ? 1
      : 0;
    if (ignored >= IGNORED_SAMPLE) {
      reporter?.info('ignoring a forwarding header from an untrusted peer', {
        peer: exchange.request.peer,
        since_last: ignored,
        why: 'the immediate peer is not in the trusted proxy set',
      });
      ignored = 0;
    }

    let decision;
    try {
      // **The reading, passed in.** One wall-clock instant drives whichever
      // store answers, which is what lets one contract suite drive both.
      const at = clock.now();
      decision = await buckets.take(key, limit, at);
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
          // The rate that is now in force, and whether it was chosen. An
          // operator reading this needs to know the fleet is collectively
          // admitting N times it — which is true and is why the number is here.
          degraded_limit: degradedLimit.limit,
          configured: options.degradedLimit !== undefined,
          error: String(error),
        });
      }
      decision = await fallback.take(key, degradedLimit, clock.now());
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
