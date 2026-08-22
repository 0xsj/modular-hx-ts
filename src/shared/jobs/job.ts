/**
 * What a job is. **L2 substrate.**
 *
 * Periodic maintenance under one roof: a name, a period, a timeout, and a
 * singleton flag. The scheduler supplies everything else — provenance, a span,
 * failure containment, and uniform logging from a returned count.
 *
 * See `notes/patterns/jobs.md`.
 */

import { type Millis } from '../clock/index.js';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { type Provenance } from '../provenance/index.js';

/** `area.verb` — `identity.purge`, `outbox.relay`, `sessions.expire`. */
const NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface JobContext {
  /**
   * Minted for this run, never derived — a job is the **root** of its own
   * chain. See the scheduler.
   */
  readonly provenance: Provenance;
  /** Aborted when the job's timeout elapses. */
  readonly signal: AbortSignal;
}

export interface Job {
  readonly name: string;

  /** How often it runs. */
  readonly period: Millis;

  /**
   * How far each instance's schedule is randomly spread.
   *
   * **Not decoration.** Every instance starting at the same second means N
   * instances racing the same lock every period, and the losers each pay a
   * round trip to find out. Defaults to a quarter of the period.
   */
  readonly jitter?: Millis;

  /** How long one run may take before it is abandoned. */
  readonly timeout?: Millis;

  /**
   * Whether the fleet runs this **once** rather than once per instance.
   *
   * **Defaults to `false`, explicitly.** A cache sweep is local and every
   * instance should do its own; a purge that deletes rows must not have two
   * workers in it. Making the default implicit is how a destructive job ends up
   * running N times because nobody wrote the flag.
   */
  readonly singleton?: boolean;

  /**
   * Do the work. **Returns how many things it did**, which is what the
   * scheduler logs — so every job reports progress the same way without each
   * one inventing a log line.
   */
  run(context: JobContext): Promise<number> | number;
}

export function isJobName(name: string): boolean {
  return NAME.test(name);
}

/** Validate a declaration at registration, which is boot rather than 3am. */
export function validate(job: Job): Result<Job> {
  if (!isJobName(job.name)) {
    return err(
      invalid(`${job.name} is not <area>.<verb> with lowercase segments`),
    );
  }
  if (job.period <= 0) {
    return err(invalid(`${job.name}: period must be positive`));
  }
  if (job.jitter !== undefined && job.jitter < 0) {
    return err(invalid(`${job.name}: jitter cannot be negative`));
  }
  if (job.timeout !== undefined && job.timeout <= 0) {
    return err(invalid(`${job.name}: timeout must be positive`));
  }
  return ok(job);
}
