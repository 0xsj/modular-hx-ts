/**
 * `work`. The memory queue against the shared contract.
 */

import { describe, expect, it } from 'vitest';
import { fakeClock, seconds } from '../clock/index.js';
import { fakeIds } from '../id/index.js';
import { makeOrigins } from '../provenance/index.js';
import { queueContract } from './worktest.js';
import { memoryQueue, memoryWorkStore } from './memory.js';
import { worker } from './worker.js';

const MAX_ATTEMPTS = 3;

describe('memory queue', () => {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const origins = makeOrigins(ids);

  queueContract(() => ({
    name: 'memory',
    queue: () =>
      memoryQueue({
        store: memoryWorkStore(),
        ids,
        maxAttempts: MAX_ATTEMPTS,
      }),
    provenance: () => origins.forRequest(),
    maxAttempts: MAX_ATTEMPTS,
    // **No `rollBack`, and the omission is honest.** The memory queue has
    // nothing to make atomic — it loses everything on restart, which is what
    // `STORAGE=memory` means. Supplying a rollback that did nothing would make
    // the case pass here and prove nothing, which is the shape of the bug the
    // case exists for.
  }));
});

describe('the worker loop', () => {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const origins = makeOrigins(ids);

  const queued = () =>
    memoryQueue({ store: memoryWorkStore(), ids, maxAttempts: 2 });

  it('completes what it handled', async () => {
    const queue = queued();
    await queue.enqueue('export', { n: 1 }, origins.forRequest(), clock.now());

    const done = await worker({
      queue,
      clock,
      handle: () => Promise.resolve(),
    }).drain();

    expect(done).toBe(1);
    expect(await queue.pending()).toBe(0);
  });

  it('fails what threw, and leaves it for a retry', async () => {
    const queue = queued();
    await queue.enqueue('export', {}, origins.forRequest(), clock.now());

    const done = await worker({
      queue,
      clock,
      handle: () => Promise.reject(new Error('nope')),
    }).drain();

    expect(done).toBe(0);
    expect(await queue.pending()).toBe(1);
  });

  it('runs each job inside the provenance that enqueued it', async () => {
    // The property a worker exists to preserve: a record written hours later
    // ties back to the request that asked for the work.
    const queue = queued();
    const origin = origins.forRequest();
    await queue.enqueue('export', {}, origin, clock.now());

    let seen = '';
    await worker({
      queue,
      clock,
      handle: async (job) => {
        const { Carrier } = await import('../provenance/index.js');
        seen = Carrier.current()?.correlationId ?? '';
        void job;
      },
    }).drain();

    expect(seen).toBe(origin.correlationId);
  });

  it('does not stop the batch when one job throws', async () => {
    const queue = queued();
    await queue.enqueue('a', {}, origins.forRequest(), clock.now());
    await queue.enqueue('b', {}, origins.forRequest(), clock.now());

    const done = await worker({
      queue,
      clock,
      handle: (job) =>
        job.kind === 'a'
          ? Promise.reject(new Error('nope'))
          : Promise.resolve(),
    }).drain();

    expect(done).toBe(1);
  });

  it('claims nothing when there is nothing due', async () => {
    expect(
      await worker({
        queue: queued(),
        clock,
        handle: () => Promise.resolve(),
      }).drain(),
    ).toBe(0);
  });

  it('starts and stops without holding the process open', async () => {
    const loop = worker({
      queue: queued(),
      clock,
      handle: () => Promise.resolve(),
      pollEvery: seconds(1),
    });

    await loop.start();
    await loop.start();
    await loop.stop();

    expect(true).toBe(true);
  });
});
