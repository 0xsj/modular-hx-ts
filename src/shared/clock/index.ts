/**
 * Time behind a port. **L0 kernel** — pure, no I/O, no process state.
 *
 * Invariant I5: **time, randomness and identifiers are injected.** No module
 * calls the wall clock. This is the only file in the repository permitted to
 * read `Date.now`, `new Date()` or `performance.now()`, and rule `M2` enforces
 * that.
 *
 * The reason is not testability alone, though a `FakeClock` is what makes a
 * retry suite finish in a millisecond instead of thirty seconds. It is that a
 * module reading the clock has a dependency it did not declare, cannot fake,
 * and therefore cannot invert — and `../ARCHITECTURE.md` §6 is blunt about
 * that: a dependency you cannot fake is a dependency you have not inverted.
 *
 * See `notes/techniques/clock.md`.
 */

import { canceled } from '../errors/index.js';
import { type Brand, unsafeBrand } from '../brand/index.js';

/**
 * A duration in milliseconds.
 *
 * Branded because the single most common time bug is a unit mix-up: a number
 * that meant seconds passed to something expecting milliseconds is off by a
 * factor of a thousand and typechecks perfectly. `seconds(30)` cannot be
 * confused with `millis(30)` once both are `Millis`.
 */
export type Millis = Brand<number, 'Millis'>;

export const millis = (value: number): Millis =>
  unsafeBrand<number, 'Millis'>(value);
export const seconds = (value: number): Millis => millis(value * 1_000);
export const minutes = (value: number): Millis => millis(value * 60_000);
export const hours = (value: number): Millis => millis(value * 3_600_000);

/**
 * The port. **Two readings, and nothing else.**
 *
 * `../../../MODULES.md` fixes this surface rather than leaving it to each repo,
 * because two repos chose differently and one of them produced a latent bug.
 *
 * - `now()` is **wall-clock** time. It is what you store, log and compare
 *   against other machines, and it moves backwards under NTP and DST.
 * - `elapsed()` only ever moves forward. It is meaningless as an absolute
 *   value and correct for measuring how long something took.
 *
 * **These are two different clocks, not two conveniences.**
 *
 * **Waiting is deliberately absent.** A module that needs to wait declares its
 * own port, because interfaces belong to the consumer — see `Sleeper` in
 * `retry`. Both implementations here offer `sleep`, so such a port always has a
 * ready implementation, without `clock` dictating its shape.
 */
export interface Clock {
  /** Wall-clock time, UTC. What a row's `created_at` records. */
  now(): Date;

  /**
   * Milliseconds from an arbitrary origin, never decreasing. Only differences
   * mean anything. Use this for latency, timeouts and backoff — rule `M13`.
   */
  elapsed(): number;
}

/**
 * Waiting, cancellably.
 *
 * Not part of `Clock`. Declared here only because both implementations below
 * satisfy it; a consumer that needs to wait should declare its own equivalent
 * and accept whatever satisfies it.
 */
export interface Sleeps {
  /**
   * Rejects with a `Canceled` error if the signal aborts — before or during the
   * wait. It never resolves early and pretends it waited.
   */
  sleep(duration: Millis, signal?: AbortSignal): Promise<void>;
}

/**
 * How long since a monotonic reading, and how long until a deadline.
 *
 * Free functions taking a `Clock` rather than methods on it: every
 * implementation would compute them identically, and a default nobody varies is
 * not part of a contract.
 */
export const since = (clock: Clock, reading: number): Millis =>
  millis(clock.elapsed() - reading);

export const until = (clock: Clock, deadline: number): Millis =>
  millis(deadline - clock.elapsed());

/** A clock a test drives by hand. */
export interface FakeClock extends Clock, Sleeps {
  /**
   * Move time forward, releasing every sleep whose deadline is now in the past,
   * in deadline order.
   */
  advance(duration: Millis): Promise<void>;

  /**
   * Jump wall-clock time without touching the monotonic reading.
   *
   * An NTP correction, in other words. Advancing moves both readings because
   * time passed; this moves only one because it did not.
   */
  setWallClock(instant: Date): void;

  /** How many sleeps are outstanding. A leak detector for tests. */
  pending(): number;
}

// --- the real one ----------------------------------------------------------

export function systemClock(): Clock & Sleeps {
  return {
    now: () => new Date(),

    elapsed: () => performance.now(),

    sleep: (duration, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(canceled('sleep aborted before it started'));
          return;
        }

        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, duration);

        function onAbort(): void {
          clearTimeout(timer);
          reject(canceled('sleep aborted'));
        }

        signal?.addEventListener('abort', onAbort, { once: true });
      }),
  };
}

// --- the fake one ----------------------------------------------------------

interface Timer {
  readonly at: number;
  readonly sequence: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
}

/**
 * A clock that only moves when a test moves it.
 *
 * Starts at a fixed instant so no test depends on the day it runs. The default
 * is deliberately not "now".
 */
export function fakeClock(
  start = new Date('2026-01-01T00:00:00.000Z'),
): FakeClock {
  let wallMs = start.getTime();
  let monotonicMs = 0;
  let sequence = 0;
  let timers: Timer[] = [];

  const fire = (timer: Timer): void => {
    timers = timers.filter((t) => t !== timer);
    timer.detach();
  };

  return {
    now: () => new Date(wallMs),

    elapsed: () => monotonicMs,

    sleep: (duration, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(canceled('sleep aborted before it started'));
          return;
        }

        // A zero or negative duration still yields, rather than resolving
        // synchronously. Otherwise a fake and a real clock disagree about
        // ordering, and a test passes that production would not.
        const timer: Timer = {
          at: monotonicMs + Math.max(0, duration),
          sequence: sequence++,
          resolve,
          reject,
          detach: () => {
            signal?.removeEventListener('abort', onAbort);
          },
        };

        function onAbort(): void {
          fire(timer);
          reject(canceled('sleep aborted'));
        }

        signal?.addEventListener('abort', onAbort, { once: true });
        timers.push(timer);
      }),

    advance: async (duration) => {
      const target = monotonicMs + Math.max(0, duration);

      for (;;) {
        // Let every continuation woken so far run to the point where it either
        // finishes or registers its next sleep.
        //
        // A single `await Promise.resolve()` is NOT enough, and the difference
        // only shows up under a real consumer: a retry loop wakes, awaits its
        // operation, wraps the result, computes a backoff and only then sleeps
        // again — several microtask turns later. Yielding a macrotask drains
        // the whole microtask queue, so the next timer is registered before
        // this loop looks for it. Without it, `advance` finds nothing due,
        // returns, and the caller waits forever.
        await new Promise<void>((resolve) => setImmediate(resolve));

        // Deadline order, then insertion order — so two sleeps ending at the
        // same instant resolve in the order they were started.
        const next = timers
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.sequence - b.sequence)
          .at(0);

        if (next === undefined) break;

        wallMs += next.at - monotonicMs;
        monotonicMs = next.at;
        fire(next);
        next.resolve();
      }

      wallMs += target - monotonicMs;
      monotonicMs = target;
    },

    setWallClock: (instant) => {
      wallMs = instant.getTime();
    },

    pending: () => timers.length,
  };
}
