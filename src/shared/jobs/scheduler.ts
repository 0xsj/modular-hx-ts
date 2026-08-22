/**
 * The scheduler. **L2 substrate.**
 *
 * Runs declared jobs with provenance, failure containment, a span, a timeout
 * and uniform logging. Registered as a `lifecycle` component, so it starts and
 * stops with the process.
 *
 * See `notes/patterns/jobs.md`.
 */

import { invariant } from '../assert/index.js';
import {
  type Clock,
  millis,
  type Millis,
  since,
  type Sleeps,
} from '../clock/index.js';
import { type Locks } from '../lock/index.js';
import { type Origins } from '../provenance/index.js';
import { Carrier } from '../provenance/index.js';
import { type Random } from '../random/index.js';
import { type Telemetry } from '../telemetry/index.js';
import { validate, type Job, type JobContext } from './job.js';

/** Three methods, declared here rather than importing `logger` — as `lifecycle` does. */
export interface Reporter {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SchedulerOptions {
  readonly clock: Clock & Sleeps;
  readonly random: Random;
  readonly origins: Origins;
  readonly locks: Locks;
  readonly telemetry: Telemetry;
  readonly reporter?: Reporter;
  /** Default per-run budget for a job that declares none. */
  readonly defaultTimeout?: Millis;
}

export type Outcome =
  'ran' | 'skipped-locked' | 'skipped-overlapping' | 'failed' | 'timed-out';

export interface RunReport {
  readonly job: string;
  readonly outcome: Outcome;
  readonly count: number;
  readonly took: Millis;
  readonly error?: string;
}

export interface Scheduler {
  add(job: Job): Scheduler;
  /** Every registered job, for an operator and for `doctor`. */
  list(): readonly Job[];
  /**
   * Run one job now, by name, outside its schedule.
   *
   * An operator who cannot invoke a purge without waiting for its period will
   * invoke it with SQL instead — which is the same work with none of the
   * locking, provenance or logging.
   */
  runNow(name: string): Promise<RunReport>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function makeScheduler(options: SchedulerOptions): Scheduler {
  const { clock, random, origins, locks, telemetry } = options;
  const defaultTimeout = options.defaultTimeout ?? millis(60_000);

  const jobs = new Map<string, Job>();
  /** Jobs with a run in flight, which is what makes overlap detectable. */
  const inFlight = new Set<string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let running = false;

  const report = (message: string, fields: Record<string, unknown>): void => {
    options.reporter?.info(message, fields);
  };

  async function execute(job: Job): Promise<RunReport> {
    const startedAt = clock.elapsed();

    // **Overlap is refused, not queued.** A job that overruns its period must
    // not be started again while the previous run is still going: an
    // overlapping purge is two workers deleting the same rows. Skipping is the
    // right answer rather than waiting, because waiting turns one slow run into
    // an unbounded queue of pending runs that all fire at once when it clears.
    if (inFlight.has(job.name)) {
      options.reporter?.warn('job still running, skipping this tick', {
        job: job.name,
      });
      return {
        job: job.name,
        outcome: 'skipped-overlapping',
        count: 0,
        took: millis(0),
      };
    }

    inFlight.add(job.name);
    try {
      return await withLockIfSingleton(job, startedAt);
    } finally {
      inFlight.delete(job.name);
    }
  }

  async function withLockIfSingleton(
    job: Job,
    startedAt: number,
  ): Promise<RunReport> {
    if (job.singleton !== true) return body(job, startedAt);

    // **This is why `jobs` and `lock` are one unit of work.** A fleet-wide lock
    // is what lets the architecture deploy as one Deployment with N replicas
    // and no separate cron process.
    const result = await locks.withLock(job.name, () => body(job, startedAt));

    if (result === undefined) {
      // Another instance has it. Not an error and not worth a warning every
      // period on every replica that did not win.
      return {
        job: job.name,
        outcome: 'skipped-locked',
        count: 0,
        took: millis(Math.round(since(clock, startedAt))),
      };
    }
    return result;
  }

  async function body(job: Job, startedAt: number): Promise<RunReport> {
    // **Minted, never derived — a job is the root of its own chain.**
    // `../../../PROVENANCE.md` §4, the mint row: actor `system:jobs/<name>`,
    // fresh request id, correlation equal to it, no causation. Getting this
    // wrong is quiet — the job runs, the records are written, and nothing joins
    // to anything.
    const provenance = origins.forJob(job.name);
    const budget = job.timeout ?? defaultTimeout;
    const controller = new AbortController();

    return Carrier.run(provenance, async () => {
      const context: JobContext = { provenance, signal: controller.signal };

      // A tagged result rather than a bare `number | Error | symbol`: the
      // symbol sentinel could not be narrowed away, and the compiler was right
      // to complain — `count` would have been `number | symbol` at the point it
      // was logged.
      type Raced =
        | { readonly kind: 'ok'; readonly count: number }
        | { readonly kind: 'error'; readonly error: Error }
        | { readonly kind: 'timeout' };

      const raced = await telemetry.tracer.inSpan(
        `job ${job.name}`,
        async (span): Promise<Raced> => {
          span.setAttribute('job', job.name);
          span.setAttribute('singleton', job.singleton === true);

          const finished: Promise<Raced> = (async () => {
            try {
              return { kind: 'ok', count: await job.run(context) };
            } catch (error) {
              // Contained: one job failing must not take the scheduler down and
              // must not stop the jobs beside it. A crashed scheduler stops
              // *all* maintenance, which is far worse than the job that threw.
              span.recordError(error);
              return {
                kind: 'error',
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
          })();

          const timeout: Promise<Raced> = clock
            .sleep(budget)
            .then(() => ({ kind: 'timeout' }) as const);

          const outcome = await Promise.race([finished, timeout]);

          if (outcome.kind === 'timeout') {
            // Signalled rather than killed: code that ignores a deadline cannot
            // be interrupted from outside, so the report says `timed-out`
            // rather than claiming the work stopped.
            controller.abort();
            span.setAttribute('timed_out', true);
          }
          return outcome;
        },
        { job: job.name },
      );

      const took = millis(Math.round(since(clock, startedAt)));

      if (raced.kind === 'timeout') {
        options.reporter?.error('job timed out', {
          job: job.name,
          budget_ms: budget,
          took_ms: took,
        });
        return { job: job.name, outcome: 'timed-out', count: 0, took };
      }

      if (raced.kind === 'error') {
        options.reporter?.error('job failed', {
          job: job.name,
          took_ms: took,
          err: raced.error,
        });
        return {
          job: job.name,
          outcome: 'failed',
          count: 0,
          took,
          error: raced.error.message,
        };
      }

      report('job ran', { job: job.name, count: raced.count, took_ms: took });
      return { job: job.name, outcome: 'ran', count: raced.count, took };
    });
  }

  /** Full jitter on the first tick, then period-plus-jitter thereafter. */
  function schedule(job: Job): void {
    if (!running) return;

    const spread = job.jitter ?? millis(Math.floor(job.period / 4));
    const delay = Math.max(
      0,
      job.period + (spread > 0 ? random.int(Math.floor(spread)) : 0),
    );

    const timer = setTimeout(() => {
      timers.delete(timer);
      void execute(job).finally(() => {
        schedule(job);
      });
    }, delay);

    // The scheduler must not be the reason a process stays alive; `lifecycle`
    // owns that decision.
    timer.unref();
    timers.add(timer);
  }

  return {
    add(job) {
      invariant(!running, 'jobs are registered before the scheduler starts');
      const checked = validate(job);
      invariant(checked.ok, `invalid job: ${job.name}`);
      invariant(!jobs.has(job.name), `a job is registered once: ${job.name}`);
      jobs.set(job.name, job);
      return this;
    },

    list: () => [...jobs.values()],

    async runNow(name) {
      const job = jobs.get(name);
      invariant(job !== undefined, `no such job: ${name}`);
      return execute(job);
    },

    async start() {
      running = true;
      for (const job of jobs.values()) schedule(job);
      report('jobs started', {
        jobs: jobs.size,
        singletons: [...jobs.values()].filter((j) => j.singleton === true)
          .length,
      });
      await Promise.resolve();
    },

    async stop() {
      running = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      // Whatever this instance holds goes back, so a rolling deploy does not
      // leave the fleet's singleton locked by an instance that has gone.
      await locks.releaseAll();
    },
  };
}
