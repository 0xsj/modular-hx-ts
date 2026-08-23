/**
 * The bucket store, behind a port. **L4 edge.**
 *
 * Two adapters and one contract suite (`I2`): a memory twin for
 * `STORAGE=memory`, and a shared implementation for everything else.
 *
 * **A per-process bucket is not a rate limit.** Four replicas each admitting
 * the configured rate admit four times it, and every single-instance test
 * passes — which is why this is a port at all, and why the contract suite runs
 * **two limiters over one store**. That is the only case that distinguishes a
 * real limiter from a local one: without it, a memory twin backed by its own
 * private map and a shared adapter backed by a table agree on every case while
 * one of them is wrong.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { type Decision, type Limit } from './bucket.js';

export interface Buckets {
  /**
   * Consume one token if there is one, and say what happened — **atomically**.
   *
   * Read-then-write is the defect this port exists to prevent: two concurrent
   * requests both observe the last token and both are admitted. The same trap
   * as `idempotency`'s claim, and the same resolution — one round trip that
   * decides, never a read followed by a write.
   */
  take(key: string, limit: Limit): Promise<Decision>;

  /** Drop buckets that have been full long enough to be indistinguishable from absent. */
  purge(idleFor: Limit): Promise<number>;
}
