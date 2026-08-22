/**
 * One contract suite; both adapters pass it. **Test tooling** — rule `S3`.
 *
 * **What it cannot assert, and says so rather than faking:** that a lock
 * survives its holder dying. That is the property the PostgreSQL adapter is
 * chosen for, and the memory adapter structurally cannot demonstrate it —
 * `STORAGE=memory` is one process, so there is no other process to lose.
 *
 * Pretending otherwise would be worse than the gap: a suite that "proved"
 * crash-safety against an in-process `Set` would give exactly the confidence
 * that must not be given. The test for it lives beside the PostgreSQL adapter,
 * where a connection can really be killed, and the difference is recorded in
 * `notes/patterns/lock.md`.
 */

import { describe, expect, it } from 'vitest';
import { type Locks } from './port.js';

export interface Subject {
  readonly locks: () => Locks;
  /** A second, independent client of the same lock service. */
  readonly other: () => Locks;
  readonly name: string;
}

let counter = 0;
/** A fresh key per case, so one leaked lease cannot fail the next test. */
const key = (): string => `contract.case-${String(++counter)}`;

export function lockContract(subject: () => Subject): void {
  describe('two holders cannot hold the same key', () => {
    it('refuses the second acquirer while the first holds it', async () => {
      const s = subject();
      const k = key();

      const first = await s.locks().tryAcquire(k);
      const second = await s.other().tryAcquire(k);

      expect(first).toBeDefined();
      // `undefined`, not a wait: a lock that queues turns a contended period
      // into a pile of instances each holding a connection open.
      expect(second).toBeUndefined();

      await first?.release();
    });

    it('hands it over once the first releases', async () => {
      const s = subject();
      const k = key();

      const first = await s.locks().tryAcquire(k);
      await first?.release();
      const second = await s.other().tryAcquire(k);

      expect(second).toBeDefined();
      await second?.release();
    });

    it('does not contend across different keys', async () => {
      const s = subject();
      const [a, b] = [key(), key()];

      const first = await s.locks().tryAcquire(a);
      const second = await s.other().tryAcquire(b);

      expect(first).toBeDefined();
      expect(second).toBeDefined();

      await first?.release();
      await second?.release();
    });

    it('is not reentrant, because each lease is its own holder', async () => {
      // The same client asking twice is still two holders. An adapter that
      // allowed it would agree with neither the other adapter nor with what a
      // second replica sees.
      const s = subject();
      const k = key();
      const locks = s.locks();

      const first = await locks.tryAcquire(k);
      const again = await locks.tryAcquire(k);

      expect(first).toBeDefined();
      expect(again).toBeUndefined();

      await first?.release();
    });
  });

  describe('withLock', () => {
    it('runs the work and returns its value', async () => {
      const s = subject();

      const result = await s.locks().withLock(key(), () => 'done');

      expect(result).toBe('done');
    });

    it('releases when the work throws', async () => {
      // The failure that matters: a lock leaked by an exception is held until
      // the process dies, and for a singleton job that means the fleet stops
      // running it entirely.
      const s = subject();
      const k = key();

      await expect(
        s.locks().withLock(k, () => {
          throw new Error('deliberate');
        }),
      ).rejects.toThrow('deliberate');

      const after = await s.other().tryAcquire(k);
      expect(after).toBeDefined();
      await after?.release();
    });

    it('does not run the work at all when the lock is held elsewhere', async () => {
      const s = subject();
      const k = key();
      let ran = false;

      const held = await s.locks().tryAcquire(k);
      const result = await s.other().withLock(k, () => {
        ran = true;
      });

      expect(ran).toBe(false);
      expect(result).toBeUndefined();

      await held?.release();
    });

    it('is safe to release twice', async () => {
      const s = subject();
      const k = key();

      const lease = await s.locks().tryAcquire(k);
      await lease?.release();
      await lease?.release();

      const after = await s.other().tryAcquire(k);
      expect(after).toBeDefined();
      await after?.release();
    });
  });

  describe('releaseAll', () => {
    it('frees everything this instance holds', async () => {
      // What `lifecycle` calls on the way down, so a rolling deploy does not
      // leave the fleet's singleton locked by an instance that has gone.
      const s = subject();
      const [a, b] = [key(), key()];
      const locks = s.locks();

      await locks.tryAcquire(a);
      await locks.tryAcquire(b);
      await locks.releaseAll();

      const other = s.other();
      const gotA = await other.tryAcquire(a);
      const gotB = await other.tryAcquire(b);

      expect(gotA).toBeDefined();
      expect(gotB).toBeDefined();

      await gotA?.release();
      await gotB?.release();
    });
  });
}
