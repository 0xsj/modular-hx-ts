/**
 * Periodic maintenance. **L2 substrate.**
 *
 * A declared `Job` — `area.verb`, a period with jitter, a timeout, a singleton
 * flag — and a scheduler that runs them with provenance, failure containment, a
 * span, and uniform logging from a returned count.
 *
 * **`jobs` and `lock` are one unit of work.** `Singleton: true` means the job
 * takes a fleet-wide lock so N replicas run it exactly once, which is what lets
 * this architecture deploy as one Deployment with N replicas and **no separate
 * cron process**.
 *
 * Note: `notes/patterns/jobs.md`.
 */

export { type Job, type JobContext, isJobName, validate } from './job.js';

export {
  type Outcome,
  type Reporter,
  type RunReport,
  type Scheduler,
  type SchedulerOptions,
  makeScheduler,
} from './scheduler.js';
