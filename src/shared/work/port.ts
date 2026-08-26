/**
 * A durable queue. **L2 substrate.**
 *
 * > enqueue in your transaction, leased worker, retry, dead-letter
 *
 * **That first clause is the design.** The row a job is about and the queue
 * entry that will process it commit together or neither does — the outbox
 * lesson applied to work rather than to events, and the same failure it
 * prevents: an export row with no job is an export that says *running* forever,
 * and a job with no export row is a worker dereferencing nothing.
 *
 * Which is why `enqueue` takes a writer. Defaulting to the pool would silently
 * turn every enqueue into a second transaction and give back exactly the
 * dual-write problem this port removes — the same signature `events` has, for
 * the same reason.
 *
 * **The reading is a parameter, never read by the store.** The same rule
 * `ratelimit` learned the expensive way: an adapter that consults its own clock
 * — `now()` in SQL, `Date.now()` in a map — cannot be driven by the contract
 * suite that is supposed to prove it agrees with its twin, so the cases about
 * *leases expiring* and *backoff elapsing* end up asserted against a fake
 * instant in one adapter and a real wait in the other. They are then not the
 * same test.
 *
 * See `notes/patterns/work.md`.
 */

import { type Millis } from '../clock/index.js';
import { type Provenance } from '../provenance/index.js';

/** What a worker is handed. Opaque payload: the queue knows no domain. */
export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  /** How many times this has been tried, including now. */
  readonly attempts: number;
  /**
   * The provenance of the request that enqueued it.
   *
   * **Carried rather than re-minted**, so a record a worker writes ties back to
   * the request that asked for the work — `PROVENANCE.md`'s carriage rule
   * across a boundary that happens to be hours wide.
   */
  readonly provenance: Provenance;
}

export interface Enqueued {
  readonly id: string;
  readonly kind: string;
}

export interface Queue {
  /**
   * Add work. **`writer` is the caller's transaction**, and passing it is the
   * point of the port.
   */
  enqueue(
    kind: string,
    payload: unknown,
    provenance: Provenance,
    at: Date,
    writer?: unknown,
  ): Promise<Enqueued>;

  /**
   * Take up to `limit` jobs, leased for `leaseFor`.
   *
   * A lease rather than a delete, so a worker that dies mid-job releases it by
   * expiry rather than losing it. That is the same choice `events`' outbox
   * makes and for the same reason: at-least-once is a property you buy by
   * making a crash indistinguishable from a slow worker.
   */
  claim(limit: number, leaseFor: Millis, at: Date): Promise<readonly Job[]>;

  /** Done. The entry goes away. */
  complete(id: string): Promise<void>;

  /**
   * Failed. Retried with backoff, or dead-lettered past `maxAttempts`.
   *
   * **Dead-lettered rather than dropped**: a job nobody can run is evidence,
   * and deleting it is deleting the only record that the work was asked for.
   */
  fail(id: string, error: string, at: Date): Promise<void>;

  /** Jobs that exhausted their attempts. Never dropped. */
  deadLetters(): Promise<
    readonly { id: string; kind: string; error: string }[]
  >;

  /** How many are waiting. For `health` and for a test. */
  pending(): Promise<number>;
}
