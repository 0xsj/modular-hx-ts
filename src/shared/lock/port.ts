/**
 * A distributed mutex, behind a port. **L2 substrate.**
 *
 * Acquire a named lock, hold it while doing work, release it. Two adapters:
 * `memory` for `STORAGE=memory`, and PostgreSQL **session-scoped advisory
 * locks** for everything else.
 *
 * See `notes/patterns/lock.md`.
 */

import { type Millis } from '../clock/index.js';

/**
 * A held lock.
 *
 * Holding one owns a resource — for the PostgreSQL adapter, a dedicated
 * connection — so it must be released. `withLock` exists so that is not the
 * caller's problem.
 */
export interface Lease {
  readonly name: string;
  release(): Promise<void>;
}

export interface Locks {
  /**
   * Take the lock, or return `undefined` if somebody else holds it.
   *
   * **Never waits.** A lock that queues turns a contended period into a pile of
   * instances each holding a connection open, which is how a fleet-wide
   * singleton becomes a fleet-wide outage. The caller that did not get it
   * should do nothing and try again next period.
   */
  tryAcquire(name: string): Promise<Lease | undefined>;

  /**
   * Run `fn` holding the lock, releasing it whatever happens.
   *
   * Returns `undefined` **without running `fn`** when the lock is held
   * elsewhere — distinguishable from `fn` returning `undefined` only if the
   * caller cares, and the callers that care return a count.
   */
  withLock<T>(name: string, fn: () => Promise<T> | T): Promise<T | undefined>;

  /** Release everything this instance holds. A `lifecycle` stop step. */
  releaseAll(): Promise<void>;
}

export interface LockOptions {
  /**
   * Part of the hashed key, so two subsystems cannot collide on one integer.
   * See `key.ts`.
   */
  readonly namespace: string;
  /** Unused by the adapters today; reserved for a waiting variant. */
  readonly timeout?: Millis;
}
