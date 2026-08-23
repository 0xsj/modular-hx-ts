/**
 * The in-memory adapter. **L4 edge.**
 *
 * `STORAGE=memory` needs zero external dependencies (invariant `I1`), and this
 * is what the unit suite and a single-process development run use.
 *
 * **What it cannot promise, and says so rather than faking:** durability. A
 * claim here dies with the process, so a restart between claiming and storing
 * forgets the key entirely rather than holding it for the lease. That is the
 * property the PostgreSQL adapter is chosen for, and the contract suite asserts
 * only what both actually provide.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { type Clock, type Millis, hours, seconds } from '../clock/index.js';
import { type Digest } from '../digest/index.js';
import { identityOf, type ScopedKey } from './key.js';
import {
  type Claim,
  type RecordOptions,
  type Records,
  type StoredResponse,
} from './port.js';

interface Entry {
  readonly fingerprint: Digest;
  /** Present once the handler finished. Absent while in flight. */
  response: StoredResponse | undefined;
  /** Spent past the cap: finished, and nothing to replay. */
  consumed: boolean;
  /** Set while in flight; cleared on completion. */
  leaseUntil: number | undefined;
  /** Set on completion; absent while in flight. */
  expiresAt: number | undefined;
}

export function memoryRecords(
  clock: Clock,
  options: RecordOptions = {},
): Records {
  const ttl: Millis = options.ttl ?? hours(24);
  const leaseFor: Millis = options.leaseFor ?? seconds(30);
  const entries = new Map<string, Entry>();

  /** Has this entry stopped mattering? Both clocks, each on its own state. */
  const finished = (entry: Entry): boolean =>
    entry.response !== undefined || entry.consumed;

  const stale = (entry: Entry, now: number): boolean =>
    finished(entry)
      ? entry.expiresAt !== undefined && entry.expiresAt <= now
      : entry.leaseUntil !== undefined && entry.leaseUntil <= now;

  /** Close the key for the replay window. Shared by `complete` and `consume`. */
  const close = (id: string, response: StoredResponse | undefined): void => {
    const entry = entries.get(id);
    if (entry === undefined) return;

    entry.response = response;
    entry.consumed = response === undefined;
    // The lease is over; the replay window begins. Two clocks, and only one of
    // them applies to a record in any given state.
    entry.leaseUntil = undefined;
    entry.expiresAt = clock.now().getTime() + ttl;
  };

  return {
    claim(key: ScopedKey, fingerprint: Digest): Promise<Claim> {
      const id = identityOf(key);
      const now = clock.now().getTime();
      const existing = entries.get(id);

      // Atomic by construction: JavaScript runs this to completion before any
      // other continuation, so there is no window between the read and the
      // write. The PostgreSQL adapter has to buy the same property.
      if (existing === undefined || stale(existing, now)) {
        entries.set(id, {
          fingerprint,
          response: undefined,
          consumed: false,
          leaseUntil: now + leaseFor,
          expiresAt: undefined,
        });
        return Promise.resolve({ outcome: 'claimed' });
      }

      // Checked before state, so a client retrying with a changed payload gets
      // case 26's 422 rather than a 409 that tells it to try again and get the
      // same 422 later.
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve({ outcome: 'mismatch' });
      }

      if (existing.consumed) return Promise.resolve({ outcome: 'consumed' });

      return Promise.resolve(
        existing.response === undefined
          ? { outcome: 'in-flight' }
          : { outcome: 'replay', response: existing.response },
      );
    },

    complete(key: ScopedKey, response: StoredResponse): Promise<void> {
      close(identityOf(key), response);
      return Promise.resolve();
    },

    consume(key: ScopedKey): Promise<void> {
      close(identityOf(key), undefined);
      return Promise.resolve();
    },

    release(key: ScopedKey): Promise<void> {
      entries.delete(identityOf(key));
      return Promise.resolve();
    },

    purge(): Promise<number> {
      const now = clock.now().getTime();
      let dropped = 0;

      for (const [id, entry] of entries) {
        // Only completed records are purged. An in-flight one whose lease has
        // expired is reclaimable, not garbage — deleting it here and letting a
        // claim recreate it are the same outcome, but purging it would hide a
        // claimant that is merely slow.
        if (finished(entry) && stale(entry, now)) {
          entries.delete(id);
          dropped += 1;
        }
      }
      return Promise.resolve(dropped);
    },
  };
}
