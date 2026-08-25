/**
 * Rate limiting. **L4 edge, and position 7 of the `httpx` chain.**
 *
 * ```ts
 * chain({ ..., ratelimit: ratelimit({ buckets, clock, limit }) }, route)
 * ```
 *
 * The wiring is one line because `httpx` left the slot named and empty. The
 * module is the work:
 *
 * - **A per-process bucket is not a rate limit.** Four replicas each admitting
 *   the configured rate admit four times it, and every single-instance test
 *   passes. The bucket lives behind a port with a shared implementation.
 * - **Check-and-consume is atomic**, or two concurrent requests both observe
 *   the last token.
 * - **Refill is monotonic** — rule `M13`.
 * - **Failing open means degrading, not switching off.** A store outage falls
 *   back to a per-process bucket sized for one replica's share, and says so.
 * - **The caller is the principal**; the peer address is a fallback, and a
 *   forwarded-for header is trusted only when a proxy is configured as trusted.
 *
 * Note: `notes/patterns/ratelimit.md`.
 */

export {
  type Decision,
  type Limit,
  decide,
  rate,
  refilled,
  timeUntil,
} from './bucket.js';

export { callerKey, forwardedFor, ignoredForwarding } from './key.js';
export {
  type ProxyTrust,
  NO_PROXIES,
  isTrusted,
  trustedProxies,
} from './trust.js';

export { type Buckets } from './port.js';

export { rateLimitHeaders, retryAfter } from './headers.js';

export {
  type RateLimitOptions,
  NEVER_LIMITED,
  ratelimit,
} from './middleware.js';

export {
  type BucketStore,
  memoryBucketStore,
  memoryBuckets,
} from './memory.js';
export { postgresBuckets } from './postgres.js';
export { BUCKETS_TABLE, ratelimitMigrations } from './schema.js';
