/**
 * One contract suite; both queues pass it. **Test tooling** — rule `S3`.
 *
 * The cases that matter are the ones a map and a table could answer
 * differently: a lease that expires, a retry that backs off, and a job that
 * dead-letters rather than disappearing.
 */

import { describe, expect, it } from 'vitest';
import { type Millis, millis, seconds } from '../clock/index.js';
import { type Queue } from './port.js';
import { type Provenance } from '../provenance/index.js';

export interface Subject {
  readonly name: string;
  readonly queue: () => Queue;
  readonly provenance: () => Provenance;
  /** Attempts before a job is dead-lettered. */
  readonly maxAttempts: number;
  /**
   * Run something inside a transaction the caller controls, and roll it back.
   *
   * **The clause that IS the design**, and the one a suite most easily omits:
   * the row a job is about and the queue entry commit together or neither
   * does. The memory twin has nothing to make atomic and says so by rolling
   * back nothing — the case still runs, and asserts what the twin can honestly
   * promise. Only the PostgreSQL adapter can fail it.
   */
  readonly rollBack?: (
    work: (writer: unknown) => Promise<void>,
  ) => Promise<void>;
}

/**
 * The one clock both adapters read. **A module-level instant, not a fixture.**
 *
 * With the reading in every call, *advance time* is one assignment and needs no
 * adapter cooperation — the same shape `ratelimit`'s suite ended up with, and
 * for the same reason: an adapter that consults its own clock cannot be driven
 * by the suite that proves it agrees with its twin.
 */
let instant = new Date('2026-03-01T00:00:00.000Z');
const now = (): Date => instant;
const advance = (duration: Millis): void => {
  instant = new Date(instant.getTime() + duration);
};

export function queueContract(subject: () => Subject): void {
  describe('enqueue and claim', () => {
    it('hands back a claimed job with its payload intact', async () => {
      const s = subject();
      const q = s.queue();

      await q.enqueue(
        'export',
        { format: 'csv', rows: 3 },
        s.provenance(),
        now(),
      );
      const claimed = await q.claim(10, seconds(30), now());

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.kind).toBe('export');
      expect(claimed[0]?.payload).toEqual({ format: 'csv', rows: 3 });
    });

    it('carries the enqueuing provenance to the worker', async () => {
      // A boundary hours wide is still a boundary: a record written by the
      // worker has to tie back to the request that asked for the work.
      const s = subject();
      const q = s.queue();
      const origin = s.provenance();

      await q.enqueue('export', {}, origin, now());
      const claimed = await q.claim(1, seconds(30), now());

      expect(claimed[0]?.provenance.correlationId).toBe(origin.correlationId);
    });

    it('counts the attempt on the claim, not on the failure', async () => {
      // A job claimed and then lost to a crash has still been attempted, and a
      // counter that only moved on an explicit failure would retry it forever.
      const s = subject();
      const q = s.queue();

      await q.enqueue('export', {}, s.provenance(), now());

      expect((await q.claim(1, seconds(30), now()))[0]?.attempts).toBe(1);
    });

    it('does not hand the same job to a second claim while it is leased', async () => {
      const s = subject();
      const q = s.queue();

      const { id } = await q.enqueue('export', {}, s.provenance(), now());
      const first = await q.claim(50, seconds(30), now());
      const second = await q.claim(50, seconds(30), now());

      // **By id**, because a shared table holds other cases' jobs and a bare
      // length assertion would be counting them.
      expect(first.some((job) => job.id === id)).toBe(true);
      expect(second.some((job) => job.id === id)).toBe(false);
    });

    it('hands it back once the lease EXPIRES, so a dead worker loses nothing', async () => {
      // The reason it is a lease rather than a delete: a crash has to be
      // indistinguishable from a slow worker, which is what at-least-once
      // costs and buys.
      const s = subject();
      const q = s.queue();

      const { id } = await q.enqueue('export', {}, s.provenance(), now());
      await q.claim(50, seconds(30), now());
      advance(seconds(31));

      expect(
        (await q.claim(50, seconds(30), now())).some((job) => job.id === id),
      ).toBe(true);
    });

    it('honours the limit', async () => {
      const s = subject();
      const q = s.queue();
      for (let i = 0; i < 5; i++) {
        await q.enqueue('export', { i }, s.provenance(), now());
      }

      expect(await q.claim(2, seconds(30), now())).toHaveLength(2);
    });
  });

  describe('enqueue in your transaction — the clause that IS the design', () => {
    it('adds nothing when the caller`s transaction rolls back', async () => {
      // **This case did not exist**, and its absence is the exact failure the
      // collection has now found twice: a transactional enqueue passes every
      // other test in this file while being inert, because every other test
      // enqueues outside a transaction and never notices the writer is
      // ignored.
      //
      // The failure it prevents in production is not subtle: an export row
      // that rolled back leaves a job whose target does not exist, and a job
      // that rolled back leaves an export that says *running* forever.
      const s = subject();
      if (s.rollBack === undefined) return;
      const q = s.queue();

      // **A delta, not an absolute.** The twin gets a fresh store per subject
      // and a real database does not — a case asserting `pending() === 0`
      // passes in memory and fails against Postgres for a reason that has
      // nothing to do with what it tests. Every count here is relative.
      const before = await q.pending();

      await s.rollBack(async (writer) => {
        await q.enqueue(
          'export',
          { doomed: true },
          s.provenance(),
          now(),
          writer,
        );
      });

      expect(await q.pending()).toBe(before);
    });

    it('adds it when the transaction commits', async () => {
      // The other half. An enqueue that never lands is not safer than one that
      // lands twice — it is a request that silently did nothing.
      const s = subject();
      const q = s.queue();
      const before = await q.pending();

      await q.enqueue('export', {}, s.provenance(), now());

      expect(await q.pending()).toBe(before + 1);
    });
  });

  describe('completing and failing', () => {
    it('removes a completed job', async () => {
      const s = subject();
      const q = s.queue();

      const before = await q.pending();
      await q.enqueue('export', {}, s.provenance(), now());
      const claimed = await q.claim(1, seconds(30), now());
      await q.complete(claimed[0]?.id ?? '');

      expect(await q.pending()).toBe(before);
    });

    it('backs a failure off rather than retrying immediately', async () => {
      // An immediate retry of a job that just failed is a tight loop against
      // whatever it was failing on.
      const s = subject();
      const q = s.queue();

      const { id } = await q.enqueue('export', {}, s.provenance(), now());
      await q.claim(50, seconds(30), now());
      await q.fail(id, 'nope', now());

      expect(
        (await q.claim(50, seconds(30), now())).some((job) => job.id === id),
      ).toBe(false);
    });

    it('retries after the backoff', async () => {
      const s = subject();
      const q = s.queue();

      const { id } = await q.enqueue('export', {}, s.provenance(), now());
      await q.claim(50, seconds(30), now());
      await q.fail(id, 'nope', now());
      advance(millis(600_000));

      expect(
        (await q.claim(50, seconds(30), now())).some((job) => job.id === id),
      ).toBe(true);
    });

    it('DEAD-LETTERS past the attempt limit rather than dropping', async () => {
      // A job nobody can run is evidence. Deleting it deletes the only record
      // that the work was ever asked for.
      const s = subject();
      const q = s.queue();

      const before = await q.pending();
      const { id } = await q.enqueue(
        'export',
        { doomed: true },
        s.provenance(),
        now(),
      );

      for (let i = 0; i <= s.maxAttempts; i++) {
        await q.claim(50, seconds(30), now());
        await q.fail(id, 'always fails', now());
        advance(millis(600_000));
      }

      expect(await q.pending()).toBe(before);
      expect((await q.deadLetters()).map((one) => one.id)).toContain(id);
    });

    it('ignores a failure for a job that is already gone', async () => {
      // A worker that completes and then crashes before acknowledging is a
      // worker whose retry calls `fail` on nothing.
      const s = subject();

      await expect(
        s.queue().fail('019b76da-a800-7000-8000-000000009999', 'late', now()),
      ).resolves.toBeUndefined();
    });
  });
}
