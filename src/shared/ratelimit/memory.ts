/**
 * The in-process adapter. **L4 edge.**
 *
 * Two jobs, and they are worth telling apart because the same code serves both:
 *
 * - the **memory twin** for `STORAGE=memory`, which invariant `I1` requires to
 *   need no external dependency;
 * - the **degraded fallback** every deployment uses when the shared store is
 *   unreachable — see `middleware.ts`.
 *
 * The store is a separate value from the limiter on purpose. Two limiters over
 * one store is the case that distinguishes a real limiter from a local one, and
 * a factory that hid its own map inside a closure could not express it — which
 * would leave the contract suite unable to ask the question that matters.
 *
 * **The reading is passed in, and this adapter used to take a clock.** It read
 * `clock.elapsed()` — monotonic, satisfying `M13` exactly — while the shared
 * adapter read PostgreSQL's `now()`. Two adapters, two clocks, one contract
 * suite: the suite could advance the twin's fake clock and not the store's, so
 * refill — the one behaviour a bucket *is* — was the one behaviour the shared
 * pair of cases could not assert on.
 *
 * `MODULES.md` §5 settles it: wall time, supplied by the caller. That is the
 * narrow exception `M13` names, because two replicas' monotonic origins are
 * unrelated and cannot refill one shared bucket. §5 permits this adapter to
 * keep a monotonic reading in its *fallback* role; it does not, deliberately —
 * two behaviours in one adapter is how the twin stops being a twin, and the
 * arithmetic in `bucket.ts` already bounds a clock step in both directions
 * (elapsed floored at zero, result capped at capacity), so the cost is at most
 * one burst and never a stall.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { millis } from '../clock/index.js';
import { type Decision, type Limit, decide, refilled } from './bucket.js';
import { type Buckets } from './port.js';

interface Entry {
  tokens: number;
  /** The wall-clock instant the caller supplied, in epoch milliseconds. */
  readAt: number;
}

/** Shared state, so two limiters can be given the same one. */
export interface BucketStore {
  readonly entries: Map<string, Entry>;
}

export function memoryBucketStore(): BucketStore {
  return { entries: new Map() };
}

export function memoryBuckets(store: BucketStore): Buckets {
  return {
    take(key: string, limit: Limit, at: Date): Promise<Decision> {
      const now = at.getTime();
      const entry = store.entries.get(key);

      // Atomic by construction: JavaScript runs this to completion before any
      // other continuation, so there is no window between the read and the
      // write. The shared adapter has to buy the same property.
      const available =
        entry === undefined
          ? limit.limit
          : refilled(entry.tokens, millis(now - entry.readAt), limit);

      const allowed = available >= 1;
      const tokens = allowed ? available - 1 : available;

      store.entries.set(key, { tokens, readAt: now });
      return Promise.resolve(decide(allowed, tokens, limit));
    },

    // `purge` reads the clock it was never given, so it takes the instant too.
    // A store that consults its own clock in one method and not the other is a
    // store the contract suite can only half drive.
    purge(idleFor: Limit, at: Date): Promise<number> {
      const now = at.getTime();
      let dropped = 0;

      for (const [key, entry] of store.entries) {
        // A full bucket is indistinguishable from one that does not exist, so
        // dropping it changes no answer — it only reclaims the memory.
        if (
          refilled(entry.tokens, millis(now - entry.readAt), idleFor) >=
          idleFor.limit
        ) {
          store.entries.delete(key);
          dropped += 1;
        }
      }
      return Promise.resolve(dropped);
    },
  };
}
