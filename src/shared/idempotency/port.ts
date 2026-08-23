/**
 * The record store, behind a port. **L4 edge.**
 *
 * Two adapters and one contract suite (`I2`): `memory` for `STORAGE=memory`,
 * PostgreSQL for everything else.
 *
 * **Two clocks, kept apart**, the same shape as the outbox relay and for the
 * same reason:
 *
 * | Clock | Governs | Expiry means |
 * | --- | --- | --- |
 * | `expiresAt` | how long a **completed** response stays replayable | the key is forgotten; a retry executes afresh |
 * | `leaseUntil` | how long an **in-flight** claim is honoured | the claimant is presumed dead; the key is reclaimable |
 *
 * One column cannot do both jobs. Without the lease, a process that dies
 * between claiming and storing leaves the key in flight forever and case 27's
 * 409 becomes **permanent** for that key — a client is then locked out of an
 * operation it never completed, and only an operator with database access can
 * free it. Collapsed the other way, a completed key would have to expire as
 * fast as a crashed claim should be released, which is minutes rather than the
 * hours a replay window is worth.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { type Millis } from '../clock/index.js';
import { type Digest } from '../digest/index.js';
import { type ScopedKey } from './key.js';

/**
 * A completed response, held for replay.
 *
 * Status and body exactly as they were. Headers are **filtered before they get
 * here** — see `capture.ts` — because a stored per-request header is a lie
 * about the response the caller is holding right now.
 */
export interface StoredResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * What a claim attempt found.
 *
 * A closed union rather than a nullable record, because the four outcomes have
 * four different status codes and collapsing any two of them loses a case the
 * conformance suite checks by name.
 */
export type Claim =
  /** Nobody holds it. Run the handler. */
  | { readonly outcome: 'claimed' }
  /** Case 25 — a completed response is on file. */
  | { readonly outcome: 'replay'; readonly response: StoredResponse }
  /** Case 26 — same key, different request. 422. */
  | { readonly outcome: 'mismatch' }
  /** Case 27 — somebody else is running it right now. 409. */
  | { readonly outcome: 'in-flight' }
  /**
   * The request ran, and its response cannot be replayed.
   *
   * Only reachable past the storage cap. **The key is spent, and a retry gets a
   * definitive answer rather than an execution** — re-running would double-apply
   * the write the key was sent to protect, and 409 would tell the client to
   * come back for a reply that is never coming.
   */
  | { readonly outcome: 'consumed' };

export interface Records {
  /**
   * Claim the key, or say why not — **atomically**.
   *
   * Read-then-write is the defect this port exists to prevent: two simultaneous
   * requests with the same key both read "absent" and both claim it, and the
   * write the client asked to have protected happens twice. Every adapter does
   * this in one statement.
   */
  claim(key: ScopedKey, fingerprint: Digest): Promise<Claim>;

  /** Store the response and start the replay window. */
  complete(key: ScopedKey, response: StoredResponse): Promise<void>;

  /**
   * Give the key back so a retry may proceed — case 28.
   *
   * Called when the failure would answer differently on a retry **and** did
   * not happen — a server fault, or a failed precondition. Everything else
   * keeps its claim; the table is in `release.ts`.
   */
  release(key: ScopedKey): Promise<void>;

  /**
   * Spend the key without storing a response.
   *
   * The handler ran and its writes are durable, but the response was too large
   * to hold. Releasing would let a retry double-apply it; leaving the claim
   * in flight would free it at the lease and let the retry double-apply it a
   * little later. This does neither: it closes the key for the replay window
   * and answers `consumed`.
   */
  consume(key: ScopedKey): Promise<void>;

  /** Drop records past `expiresAt`. A `jobs` step, not a request-path one. */
  purge(): Promise<number>;
}

export interface RecordOptions {
  /**
   * How long a **completed** response stays replayable.
   *
   * 24 hours matches what clients are told to expect by every API that
   * documents this, and it is long enough that a retry after a network
   * partition still lands inside it.
   */
  readonly ttl?: Millis;

  /**
   * How long an **in-flight** claim is honoured before the claimant is presumed
   * dead.
   *
   * Bounded by how long a request can take, not by how long a replay is worth —
   * which is the whole reason it is a second column.
   */
  readonly leaseFor?: Millis;
}
