/**
 * The in-process queue. **`STORAGE=memory` is a real mode** — `I1`.
 *
 * **The transaction argument is honestly ignored.** There is nothing to make
 * atomic in one process with no database, and pretending otherwise would be a
 * lie about durability rather than a simplification: the memory queue loses
 * everything on restart, which is what `STORAGE=memory` means.
 */

import { type Millis } from '../clock/index.js';
import { type Provenance } from '../provenance/index.js';
import { type Enqueued, type Job, type Queue } from './port.js';

interface Entry {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly provenance: Provenance;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | undefined;
  lastError: string | undefined;
}

export interface WorkStore {
  readonly jobs: Map<string, Entry>;
  readonly dead: Map<string, { kind: string; error: string }>;
}

export function memoryWorkStore(): WorkStore {
  return { jobs: new Map(), dead: new Map() };
}

export interface MemoryOptions {
  readonly store: WorkStore;
  readonly ids: { uuid(): string };
  readonly maxAttempts?: number;
  readonly backoff?: (attempts: number) => Millis;
}

export function memoryQueue(options: MemoryOptions): Queue {
  const { store, ids } = options;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoff =
    options.backoff ??
    ((attempts: number) => Math.min(300_000, 1_000 * 2 ** attempts) as Millis);

  return {
    enqueue(kind, payload, provenance, at) {
      const id = ids.uuid();
      store.jobs.set(id, {
        id,
        kind,
        payload,
        provenance,
        attempts: 0,
        nextAttemptAt: at.getTime(),
        leaseUntil: undefined,
        lastError: undefined,
      });
      return Promise.resolve({ id, kind } satisfies Enqueued);
    },

    claim(limit, leaseFor, at) {
      const now = at.getTime();
      const taken: Job[] = [];

      for (const entry of store.jobs.values()) {
        if (taken.length >= limit) break;
        if (entry.nextAttemptAt > now) continue;
        if (entry.leaseUntil !== undefined && entry.leaseUntil > now) continue;

        entry.leaseUntil = now + leaseFor;
        entry.attempts += 1;
        taken.push({
          id: entry.id,
          kind: entry.kind,
          payload: entry.payload,
          attempts: entry.attempts,
          provenance: entry.provenance,
        });
      }

      return Promise.resolve(taken);
    },

    complete(id) {
      store.jobs.delete(id);
      return Promise.resolve();
    },

    fail(id, error, at) {
      const entry = store.jobs.get(id);
      if (entry === undefined) return Promise.resolve();

      if (entry.attempts >= maxAttempts) {
        // **Dead-lettered, never dropped.** A job nobody can run is evidence,
        // and deleting it deletes the only record the work was asked for.
        store.dead.set(id, { kind: entry.kind, error });
        store.jobs.delete(id);
        return Promise.resolve();
      }

      entry.lastError = error;
      entry.leaseUntil = undefined;
      entry.nextAttemptAt = at.getTime() + backoff(entry.attempts);
      return Promise.resolve();
    },

    deadLetters() {
      return Promise.resolve(
        [...store.dead.entries()].map(([id, one]) => ({
          id,
          kind: one.kind,
          error: one.error,
        })),
      );
    },

    pending() {
      return Promise.resolve(store.jobs.size);
    },
  };
}
