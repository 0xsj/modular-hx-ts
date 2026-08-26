/**
 * The loop that drains the queue. **`work` L2.**
 *
 * Separate from the `Queue` port because they are different things: the port is
 * *where work lives*, and this is *a process choosing to do some*. A queue with
 * a loop welded on is a queue that cannot be enqueued into by a process that
 * does no work, which is most of them — an API replica enqueues and a worker
 * replica drains, and both use the same port.
 *
 * **Every job runs inside its own provenance.** The one the enqueuing request
 * carried, restored here, so a record written hours later ties back to the
 * request that asked for the work.
 */

import { type Millis, seconds } from '../clock/index.js';
import { Carrier } from '../provenance/index.js';
import { type Job, type Queue } from './port.js';

export interface WorkerOptions {
  readonly queue: Queue;
  /** The reading every call passes on. Injected — `M2`. */
  readonly clock: { now(): Date };
  /** What to do with a job. Throwing is how a job fails. */
  readonly handle: (job: Job) => Promise<void>;
  readonly batchSize?: number;
  readonly leaseFor?: Millis;
  readonly pollEvery?: Millis;
  readonly reporter?: {
    error(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface Worker {
  /** One pass. Returns how many jobs completed. */
  drain(): Promise<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function worker(options: WorkerOptions): Worker {
  const { queue, handle } = options;
  const batchSize = options.batchSize ?? 8;
  const leaseFor = options.leaseFor ?? seconds(60);
  const pollEvery = options.pollEvery ?? seconds(1);

  let timer: ReturnType<typeof setInterval> | undefined;
  let draining = false;

  const self: Worker = {
    async drain() {
      const claimed = await queue.claim(
        batchSize,
        leaseFor,
        options.clock.now(),
      );
      let done = 0;

      for (const job of claimed) {
        // **The enqueuing request's provenance, restored.** A record this
        // writes carries the correlation id of the request that asked for the
        // work — `PROVENANCE.md`'s carriage rule across a boundary that is
        // hours wide rather than a function call.
        const outcome = await Carrier.run(job.provenance, async () => {
          try {
            await handle(job);
            return undefined;
          } catch (error) {
            return String(error);
          }
        });

        if (outcome === undefined) {
          await queue.complete(job.id);
          done += 1;
          continue;
        }

        options.reporter?.error('a job failed', {
          job: job.id,
          kind: job.kind,
          attempts: job.attempts,
          error: outcome,
        });
        await queue.fail(job.id, outcome, options.clock.now());
      }

      return done;
    },

    start() {
      if (timer !== undefined) return Promise.resolve();
      timer = setInterval(() => {
        // Never two passes at once: a drain slower than the interval would
        // stack, and each pass takes its own lease.
        if (draining) return;
        draining = true;
        void self
          .drain()
          .catch((error: unknown) => {
            options.reporter?.error('a worker pass failed', {
              error: String(error),
            });
          })
          .finally(() => {
            draining = false;
          });
      }, pollEvery);
      // Never hold the process open: shutdown is `lifecycle`'s to decide.
      timer.unref();
      return Promise.resolve();
    },

    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      return Promise.resolve();
    },
  };

  return self;
}
