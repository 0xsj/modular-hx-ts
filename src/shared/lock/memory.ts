/**
 * In-process locks. **The `STORAGE=memory` adapter.**
 *
 * **It is a mutex, not a distributed one**, and the difference is the whole
 * reason the note exists: this cannot demonstrate the property the PostgreSQL
 * adapter is chosen for — that a lock survives its holder dying. There is only
 * one process, so there is no other process to lose.
 *
 * That is not a defect. `STORAGE=memory` is a single process by definition
 * (invariant `I1`), and within one process this is exactly correct.
 *
 * See `notes/patterns/lock.md`.
 */

import { type Lease, type Locks } from './port.js';
import { qualify } from './key.js';

export function memoryLocks(namespace: string): Locks {
  const held = new Set<string>();

  const release = (key: string): void => {
    held.delete(key);
  };

  return {
    tryAcquire(name: string) {
      const key = qualify(namespace, name);
      // Not reentrant, deliberately: a second lease on a held key fails here
      // exactly as it fails against PostgreSQL, where each lease holds its own
      // session. An adapter that allowed it would agree with nothing.
      if (held.has(key)) return Promise.resolve(undefined);
      held.add(key);

      let released = false;
      return Promise.resolve({
        name,
        release: () => {
          if (released) return Promise.resolve();
          released = true;
          release(key);
          return Promise.resolve();
        },
      } satisfies Lease);
    },

    async withLock<T>(name: string, fn: () => Promise<T> | T) {
      const lease = await this.tryAcquire(name);
      if (lease === undefined) return undefined;

      try {
        return await fn();
      } finally {
        await lease.release();
      }
    },

    releaseAll() {
      held.clear();
      return Promise.resolve();
    },
  };
}
