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
 * **`at` is passed in, never read by the store.** `MODULES.md` §5 is explicit
 * and the reason is this file's own contract suite: the memory twin and the
 * shared adapter run the *same* cases, and a suite that advances a fake clock
 * would move one and not the other. The shared adapter used the database's
 * `now()` and the twin used an injected clock, so the two were driven by two
 * clocks and the suite could only ever assert on the intersection — which is
 * everything except refill, the one behaviour the bucket is.
 *
 * It is **wall time**, not a monotonic reading, and that is the narrow
 * exception `M13` names: two replicas' monotonic origins are unrelated, so
 * their readings cannot refill one shared bucket. Skew between replicas becomes
 * a bounded inaccuracy instead of a correctness bug.
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
  take(key: string, limit: Limit, at: Date): Promise<Decision>;

  /**
   * Drop buckets full long enough to be indistinguishable from absent.
   *
   * Takes the reading for the same reason `take` does: a store that consults
   * its own clock in one method and not the other is a store the contract suite
   * can only half drive.
   */
  purge(idleFor: Limit, at: Date): Promise<number>;
}
