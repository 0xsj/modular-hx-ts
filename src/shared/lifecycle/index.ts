/**
 * Ordered start, reverse-order stop, signals. **L1 runtime.**
 *
 * A process is a stack of things that must come up in dependency order and go
 * down in the opposite one. Getting the second half wrong is how a shutdown
 * closes the database while a request is still using it, and the symptom is an
 * error at the end of every deploy that nobody can reproduce.
 *
 * Three properties do the work:
 *
 * - **Reverse order on the way down.** Always, including when start failed
 *   halfway — a component that never started is never stopped, and one that did
 *   always is.
 * - **A failure to stop does not stop the shutdown.** The rest still get their
 *   turn, and every failure is reported together.
 * - **Nothing hangs forever.** A component that will not stop is given a bounded
 *   time and then left behind, because a process that refuses to exit gets
 *   `SIGKILL` and loses everything the others were about to finish cleanly.
 *
 * `../../../INFRASTRUCTURE.md` §7.3: `terminationGracePeriodSeconds` must exceed
 * the grace timeout here plus the longest request timeout, or the orchestrator
 * kills work this was about to finish.
 *
 * See `notes/patterns/lifecycle.md`.
 */

import { invariant } from '../assert/index.js';
import {
  type Clock,
  type Millis,
  seconds,
  since,
  type Sleeps,
} from '../clock/index.js';
import { type AppError, internal, wrap } from '../errors/index.js';
import { attemptAsync, err, isErr, ok, type Result } from '../result/index.js';

/**
 * Something with a lifetime.
 *
 * Both halves are optional: a component may only need to be torn down (a
 * connection pool handed in already open), or only set up (a warm cache). What
 * it may not do is have neither, which is a component that does nothing.
 */
export interface Component {
  /** Named, because every message about it uses this. */
  readonly name: string;
  start?: () => Promise<void> | void;
  stop?: () => Promise<void> | void;
}

/**
 * What this module needs to say. Declared here rather than imported from
 * `logger`, so nothing in the shutdown path depends on a peer at the same
 * layer — and `logger`'s own `Logger` satisfies it as it is.
 */
export interface Reporter {
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const SILENT: Reporter = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export type State = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface LifecycleOptions {
  /** Injected: rule `M2`, and it is what makes a shutdown test instant. */
  readonly clock: Clock & Sleeps;
  readonly reporter?: Reporter;
  /** How long any one component gets to stop. */
  readonly stopTimeout?: Millis;
  /** How long the whole shutdown gets, however many components remain. */
  readonly graceTimeout?: Millis;
}

export interface Lifecycle {
  /** Register a component. Start order is registration order. */
  add(component: Component): Lifecycle;

  /**
   * Start everything, in order.
   *
   * If one fails, everything already started is stopped in reverse order before
   * returning — a half-started process is worse than a stopped one, and it is
   * the state most likely to hold a port or a lock nobody will release.
   */
  start(): Promise<Result<void>>;

  /** Stop everything, in reverse order. Safe to call more than once. */
  stop(reason?: string): Promise<Result<void>>;

  /**
   * Stop on `SIGINT` or `SIGTERM`, and return the handlers' removal.
   *
   * A **second** signal means the operator has stopped waiting: `onImpatience`
   * runs, and the usual answer is to exit immediately. Ignoring it is how a
   * hung process has to be killed twice.
   *
   * **This also keeps the process alive.** A signal listener does *not* hold
   * Node's event loop open, so a process whose components reference nothing —
   * no server listening yet, no timer pending — drains and exits before any
   * signal can arrive. The thing that says "we are waiting for a signal" is the
   * right place to do the waiting; it is released on stop.
   */
  handleSignals(onImpatience?: () => void): () => void;

  /** Resolves once `stop` has finished, whatever started it. */
  stopped(): Promise<void>;

  readonly state: State;
}

export function makeLifecycle(options: LifecycleOptions): Lifecycle {
  const { clock } = options;
  const report = options.reporter ?? SILENT;
  const stopTimeout = options.stopTimeout ?? seconds(10);
  const graceTimeout = options.graceTimeout ?? seconds(25);

  const components: Component[] = [];
  /** Only what actually started, so only that is stopped. */
  const started: Component[] = [];

  let state: State = 'idle';
  let stopping: Promise<Result<void>> | undefined;
  let settle: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  /**
   * Run one step, or give up on it.
   *
   * `Promise.race` rather than an abort: a component that ignores a deadline
   * cannot be interrupted from outside, so the honest thing is to stop waiting
   * and say so. The step may still be running, which is why the message says
   * `timed out` rather than `failed`.
   */
  const within = async (
    budget: Millis,
    what: string,
    step: () => Promise<void> | void,
  ): Promise<Result<void>> => {
    const timeout = Symbol('timeout');

    const outcome = await Promise.race([
      attemptAsync(async () => {
        await step();
      }, what),
      clock.sleep(budget).then(() => timeout),
    ]);

    // `typeof` rather than an identity check: it is what narrows the union.
    if (typeof outcome === 'symbol') {
      return err(internal(`${what} timed out after ${String(budget)}ms`));
    }
    return outcome;
  };

  const stopAll = async (reason: string): Promise<Result<void>> => {
    state = 'stopping';
    const startedAt = clock.elapsed();
    const failures: AppError[] = [];

    report.info('stopping', { reason, components: started.length });

    // Reverse order: the last thing up is the first thing down.
    for (const component of [...started].reverse()) {
      if (since(clock, startedAt) >= graceTimeout) {
        // The budget is spent. Say exactly what is being abandoned, because
        // this line is the only record that it was.
        report.error('grace period exhausted, abandoning the rest', {
          remaining: started.indexOf(component) + 1,
        });
        failures.push(internal('shutdown exceeded its grace period'));
        break;
      }

      if (component.stop === undefined) continue;

      const at = clock.elapsed();
      const outcome = await within(stopTimeout, `stop ${component.name}`, () =>
        component.stop?.(),
      );

      if (isErr(outcome)) {
        // Deliberately not fatal. The remaining components still get their
        // turn, because one that will not close is no reason to leak the rest.
        failures.push(outcome.error);
        report.error('component failed to stop', {
          component: component.name,
          err: outcome.error,
        });
        continue;
      }

      report.info('stopped', {
        component: component.name,
        took_ms: Math.round(since(clock, at)),
      });
    }

    started.length = 0;
    state = 'stopped';
    settle?.();

    report.info('stopped', {
      reason,
      took_ms: Math.round(since(clock, startedAt)),
      failures: failures.length,
    });

    return failures.length === 0
      ? ok(undefined)
      : err(
          internal(
            `${String(failures.length)} component${failures.length === 1 ? '' : 's'} failed to stop`,
            { cause: failures[0] },
          ),
        );
  };

  return {
    add(component) {
      invariant(state === 'idle', 'components are registered before starting');
      invariant(component.name !== '', 'a component is named');
      components.push(component);
      return this;
    },

    async start() {
      invariant(state === 'idle', 'a lifecycle starts once');
      state = 'starting';

      for (const component of components) {
        if (component.start === undefined) {
          started.push(component);
          continue;
        }

        const at = clock.elapsed();
        const outcome = await within(
          stopTimeout,
          `start ${component.name}`,
          () => component.start?.(),
        );

        if (isErr(outcome)) {
          report.error('component failed to start', {
            component: component.name,
            err: outcome.error,
          });

          // Unwind what is already up. A half-started process holds ports and
          // locks that nothing will release.
          await stopAll('failed to start');
          return err(wrap(outcome.error, 'start'));
        }

        started.push(component);
        report.info('started', {
          component: component.name,
          took_ms: Math.round(since(clock, at)),
        });
      }

      state = 'running';
      report.info('started', { components: started.length });
      return ok(undefined);
    },

    async stop(reason = 'requested') {
      if (state === 'stopped' || state === 'idle') return ok(undefined);

      // Idempotent: a second SIGTERM, or a signal arriving during a manual
      // stop, joins the shutdown already running rather than starting another.
      stopping ??= stopAll(reason);
      return stopping;
    },

    handleSignals(onImpatience) {
      let signalled = false;
      const keepAlive = setInterval(() => undefined, 1 << 30);
      const release = (): void => {
        clearInterval(keepAlive);
      };
      void finished.then(release, release);

      const handlers = (['SIGINT', 'SIGTERM'] as const).map((signal) => {
        const handler = (): void => {
          if (signalled) {
            report.warn('second signal, exiting now', { signal });
            onImpatience?.();
            return;
          }
          signalled = true;
          void this.stop(signal);
        };

        process.on(signal, handler);
        return [signal, handler] as const;
      });

      return () => {
        release();
        for (const [signal, handler] of handlers) {
          process.removeListener(signal, handler);
        }
      };
    },

    stopped: () => finished,

    get state() {
      return state;
    },
  };
}
