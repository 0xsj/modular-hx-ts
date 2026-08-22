/**
 * Liveness, readiness, and the difference between them. **L1 runtime.**
 *
 * Two questions that look alike and are not:
 *
 * - **Liveness** — *is this process broken beyond recovery?* The answer decides
 *   whether it is **restarted**. It checks nothing external, ever.
 * - **Readiness** — *should this instance receive traffic right now?* The answer
 *   decides whether it stays in the load balancer.
 *
 * **Conflating them is a specific outage.** If liveness checks the database,
 * then a database blip restarts every pod at once, all of them reconnect
 * simultaneously, and a brief outage becomes a long one — the orchestrator
 * turning a dependency's bad minute into your bad hour. `/healthz` reflects
 * liveness only; `/readyz` reflects dependencies (conformance 41).
 *
 * The second distinction is **critical versus optional**. A failing critical
 * dependency means this instance cannot serve, so it leaves the pool. A failing
 * optional one means **degraded, never down** — conformance 42, and
 * `../../../INFRASTRUCTURE.md` §7.4 names the trap: failing readiness on a
 * backlog hands your traffic to the instances already behind on the same queue,
 * which is exactly the wrong direction.
 *
 * See `notes/patterns/health.md`.
 */

import { invariant } from '../assert/index.js';
import {
  type Clock,
  millis,
  type Millis,
  seconds,
  since,
  type Sleeps,
} from '../clock/index.js';
import { type Kind, kindOf } from '../errors/index.js';
import { attemptAsync, isErr } from '../result/index.js';

export type Importance = 'critical' | 'optional';

/**
 * `healthy` and `degraded` both serve traffic. Only `unhealthy` leaves the pool.
 *
 * Three states rather than two because the middle one is the useful one: it is
 * what a dashboard shows and an alert fires on, without taking the instance out
 * of rotation.
 */
export type Status = 'healthy' | 'degraded' | 'unhealthy';

export interface Check {
  readonly name: string;
  /**
   * `critical` — this instance cannot serve without it.
   * `optional` — it is worse without it, and it still serves.
   *
   * Most things are optional. A checker is critical only when serving a request
   * without it produces a wrong answer rather than a slower one.
   */
  readonly importance: Importance;
  /** Throws or rejects to fail. Anything returned is ignored. */
  run(): Promise<void> | void;
}

export interface CheckReport {
  readonly name: string;
  readonly importance: Importance;
  readonly healthy: boolean;
  readonly took: Millis;
  /** The failure's message. Never internals — a probe response is public. */
  readonly error?: string;
  readonly kind?: Kind;
}

export interface Report {
  readonly status: Status;
  readonly at: Date;
  readonly took: Millis;
  readonly checks: readonly CheckReport[];
}

export interface HealthOptions {
  readonly clock: Clock & Sleeps;
  /** How long any one check gets before it is called failed. */
  readonly timeout?: Millis;
  /**
   * How long a readiness answer is reused.
   *
   * Probes arrive from the orchestrator, the load balancer and whatever else is
   * watching, and each one running a real query multiplies that load onto the
   * dependency least able to take it. Zero disables it.
   */
  readonly ttl?: Millis;
}

export interface Health {
  add(check: Check): Health;

  /**
   * Is the process alive?
   *
   * Runs **no checks**. If this function can return, the answer is yes — that
   * is the whole of liveness, and anything more turns a dependency's outage
   * into a restart loop.
   */
  live(): Report;

  /** Should this instance receive traffic? Runs every check. */
  ready(): Promise<Report>;

  /**
   * Report not-ready from now on, without stopping anything.
   *
   * Called first in shutdown so the load balancer stops sending work *before*
   * components start closing — `../../../INFRASTRUCTURE.md` §7.3. In-flight
   * requests then finish against a process that is still fully assembled.
   */
  drain(): void;

  readonly draining: boolean;
}

export function makeHealth(options: HealthOptions): Health {
  const { clock } = options;
  const timeout = options.timeout ?? seconds(2);
  const ttl = options.ttl ?? seconds(1);

  const checks: Check[] = [];
  let draining = false;
  let cached: { at: number; report: Report } | undefined;

  const runCheck = async (check: Check): Promise<CheckReport> => {
    const startedAt = clock.elapsed();
    const expired = Symbol('timeout');

    const outcome = await Promise.race([
      attemptAsync(async () => {
        await check.run();
      }, check.name),
      clock.sleep(timeout).then(() => expired),
    ]);

    const took = millis(Math.round(since(clock, startedAt)));

    if (typeof outcome === 'symbol') {
      // A check that will not answer is a check that failed. Waiting longer
      // only makes the probe itself time out, which reads as a dead process.
      return {
        name: check.name,
        importance: check.importance,
        healthy: false,
        took,
        error: `timed out after ${String(timeout)}ms`,
      };
    }

    if (isErr(outcome)) {
      return {
        name: check.name,
        importance: check.importance,
        healthy: false,
        took,
        error: outcome.error.message,
        kind: kindOf(outcome.error),
      };
    }

    return {
      name: check.name,
      importance: check.importance,
      healthy: true,
      took,
    };
  };

  /**
   * Roll the checks up.
   *
   * A failing **critical** check means unhealthy; a failing **optional** one
   * means degraded, which still serves. That asymmetry is the module.
   */
  const summarize = (reports: readonly CheckReport[]): Status => {
    if (reports.some((r) => !r.healthy && r.importance === 'critical')) {
      return 'unhealthy';
    }
    return reports.some((r) => !r.healthy) ? 'degraded' : 'healthy';
  };

  return {
    add(check) {
      invariant(check.name !== '', 'a check is named');
      invariant(
        !checks.some((existing) => existing.name === check.name),
        `a check is registered once: ${check.name}`,
      );
      checks.push(check);
      return this;
    },

    live: () => ({
      // Deliberately empty. Reaching this line *is* the liveness answer.
      status: draining ? 'degraded' : 'healthy',
      at: clock.now(),
      took: millis(0),
      checks: [],
    }),

    async ready() {
      if (draining) {
        // Not a check failure — a decision. Reported before anything is run,
        // because the answer cannot change while draining.
        return {
          status: 'unhealthy',
          at: clock.now(),
          took: millis(0),
          checks: [
            {
              name: 'draining',
              importance: 'critical',
              healthy: false,
              took: millis(0),
              error: 'shutting down',
            },
          ],
        };
      }

      if (cached !== undefined && since(clock, cached.at) < ttl) {
        return cached.report;
      }

      const startedAt = clock.elapsed();
      // Concurrently: checks are independent, and a probe that took the sum of
      // them would time out long before the slowest one mattered.
      const reports = await Promise.all(checks.map(runCheck));

      const report: Report = {
        status: summarize(reports),
        at: clock.now(),
        took: millis(Math.round(since(clock, startedAt))),
        checks: reports,
      };

      cached = { at: startedAt, report };
      return report;
    },

    drain() {
      draining = true;
      // Whatever was cached said "ready", and it no longer is.
      cached = undefined;
    },

    get draining() {
      return draining;
    },
  };
}

/**
 * Whether a report means "send me traffic".
 *
 * `degraded` is ready. That is conformance 42 in one line, and the reason this
 * helper exists rather than each transport comparing strings and getting it
 * wrong somewhere.
 */
export function servesTraffic(report: Report): boolean {
  return report.status !== 'unhealthy';
}

/** The status code a probe should answer with. `httpx` will use this. */
export function statusCode(report: Report): number {
  return servesTraffic(report) ? 200 : 503;
}
