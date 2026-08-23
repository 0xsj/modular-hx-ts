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
 * **This is the adapter that satisfies `M13` exactly**: the reading is
 * `clock.elapsed()`, monotonic by construction, so a wall-clock correction
 * moves nothing here.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { type Clock, millis } from '../clock/index.js';
import { type Decision, type Limit, decide, refilled } from './bucket.js';
import { type Buckets } from './port.js';

interface Entry {
  tokens: number;
  /** A monotonic reading, never a wall-clock instant. */
  readAt: number;
}

/** Shared state, so two limiters can be given the same one. */
export interface BucketStore {
  readonly entries: Map<string, Entry>;
}

export function memoryBucketStore(): BucketStore {
  return { entries: new Map() };
}

export function memoryBuckets(store: BucketStore, clock: Clock): Buckets {
  return {
    take(key: string, limit: Limit): Promise<Decision> {
      const now = clock.elapsed();
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

    purge(idleFor: Limit): Promise<number> {
      const now = clock.elapsed();
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
