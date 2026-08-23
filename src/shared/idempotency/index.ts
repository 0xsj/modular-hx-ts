/**
 * Idempotency. **L4 edge, and position 9 of the `httpx` chain.**
 *
 * **Claim before running, replay stored responses bit for bit, fail closed.**
 *
 * ```ts
 * chain({ ..., idempotency: idempotency({ records }) }, route)
 * ```
 *
 * The wiring is one line because `httpx` left the slot named and empty. The
 * module is the work:
 *
 * - **The key is scoped, never global** — the client's key *plus* the tenant
 *   and the authenticated principal. A bare key is a cross-tenant read.
 * - **The fingerprint is a digest of the canonical request**, so a
 *   re-serialized identical payload is not mistaken for a different one.
 * - **Two clocks**: `expiresAt` for how long a completed response replays,
 *   `leaseUntil` for how long an in-flight claim is honoured. One column cannot
 *   do both jobs.
 * - **Release on 5xx, hold on 4xx.**
 * - **The store fails closed.** Unreachable is 503, never "proceed unclaimed".
 *
 * Note: `notes/patterns/idempotency.md`.
 */

export {
  type ScopedKey,
  KEY_HEADER,
  REPLAY_HEADER,
  fingerprint,
  identityOf,
  scopedKey,
} from './key.js';

export {
  type Claim,
  type RecordOptions,
  type Records,
  type StoredResponse,
} from './port.js';

export {
  MAX_STORED_BYTES,
  exceedsCap,
  storableHeaders,
  storedSize,
} from './capture.js';

export { releasesKey } from './release.js';

export { type IdempotencyOptions, idempotency } from './middleware.js';

export { memoryRecords } from './memory.js';
export { postgresRecords } from './postgres.js';
export { RECORDS_TABLE, idempotencyMigrations } from './schema.js';
