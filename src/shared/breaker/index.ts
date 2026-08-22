/**
 * Keyed circuit breaker. **L0 kernel** — pure, no I/O, no process state.
 *
 * `retry` handles a blip. This handles a dependency that is actually down:
 * once enough calls to one key have failed, stop making them, and fail fast
 * instead. Retrying through something that is gone is how a partial outage
 * becomes a total one — every caller holds a connection and a worker for the
 * full timeout, and the queue behind them backs up into everything else.
 *
 * Invariant I9 — fail-open versus fail-closed is decided per concern,
 * deliberately, and logged when it fires. This is an **availability** control:
 * an open circuit refuses calls, which is the intended behaviour and not a
 * failure of the mechanism. `onStateChange` is how it becomes visible.
 *
 * See `notes/techniques/breaker.md`.
 */

import { invariant } from '../assert/index.js';
import { type Clock, type Millis, seconds } from '../clock/index.js';
import { type AppError, isRetryable, unavailable } from '../errors/index.js';
import { attemptAsync, err, isErr, type Result } from '../result/index.js';

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerPolicy {
  /** How far back the failure ratio looks. */
  readonly window: Millis;

  /** Granularity of the rolling window. More buckets, smoother expiry. */
  readonly buckets: number;

  /** Never trip below this many calls in the window. */
  readonly minimumThroughput: number;

  /** Trip at or above this failure ratio, in `[0, 1]`. */
  readonly failureRatio: number;

  /** How long to stay open before allowing one probe. */
  readonly resetAfter: Millis;

  /**
   * Which failures count against the dependency's health. Defaults to
   * `errors.isRetryable` — the same decision `retry` makes, so the two cannot
   * drift apart.
   */
  readonly countsAsFailure?: (error: AppError) => boolean;
}

export const DEFAULT_POLICY: BreakerPolicy = {
  window: seconds(30),
  buckets: 10,
  minimumThroughput: 20,
  failureRatio: 0.5,
  resetAfter: seconds(15),
};

export interface StateChange {
  readonly key: string;
  readonly from: BreakerState;
  readonly to: BreakerState;
  readonly failures: number;
  readonly total: number;
}

export interface Snapshot {
  readonly state: BreakerState;
  readonly failures: number;
  readonly total: number;
}

export interface Breaker {
  /** Run an operation under the breaker for `key`. */
  run<T>(
    key: string,
    operation: () => Promise<T>,
    describe: string,
  ): Promise<Result<T>>;

  /** For metrics and for tests. */
  snapshot(key: string): Snapshot;
}

interface Bucket {
  epoch: number;
  ok: number;
  failed: number;
}

interface KeyState {
  state: BreakerState;
  openedAt: number;
  probeInFlight: boolean;
  buckets: Bucket[];
}

/**
 * A rolling window, not a consecutive-failure count.
 *
 * **This is the whole reason the module is more than ten lines.** A
 * consecutive counter resets on every success, so an endpoint failing half its
 * calls — the flapping dependency that hurts most, and the one that fills a
 * worker pool with timeouts — never fails twice in a row and never trips.
 * Counting over a window measures the thing that matters: what fraction of
 * recent calls failed.
 *
 * O(buckets) per read, with `buckets` fixed and small. Memory is O(keys ×
 * buckets), which is why keys are hosts and not URLs.
 */
function makeWindow(buckets: number): Bucket[] {
  return Array.from({ length: buckets }, () => ({
    epoch: -1,
    ok: 0,
    failed: 0,
  }));
}

export function makeBreaker(
  clock: Clock,
  policy: BreakerPolicy = DEFAULT_POLICY,
  onStateChange?: (change: StateChange) => void,
): Breaker {
  invariant(
    Number.isInteger(policy.buckets) && policy.buckets >= 1,
    'buckets is a positive integer',
  );
  invariant(
    policy.failureRatio > 0 && policy.failureRatio <= 1,
    'failureRatio is in (0, 1]',
  );
  invariant(policy.minimumThroughput >= 1, 'minimumThroughput is at least 1');

  const bucketMs = policy.window / policy.buckets;
  const counts = policy.countsAsFailure ?? isRetryable;
  const keys = new Map<string, KeyState>();

  const stateFor = (key: string): KeyState => {
    const existing = keys.get(key);
    if (existing !== undefined) return existing;

    const created: KeyState = {
      state: 'closed',
      openedAt: 0,
      probeInFlight: false,
      buckets: makeWindow(policy.buckets),
    };
    keys.set(key, created);
    return created;
  };

  // Rule M13: the window is measured on the monotonic reading. A cooldown
  // computed from wall-clock arithmetic holds a circuit open for an hour after
  // a one-second NTP correction, and closes one early after a jump forward.
  const epochNow = (): number => Math.floor(clock.elapsed() / bucketMs);

  const totals = (entry: KeyState): { failures: number; total: number } => {
    const oldest = epochNow() - policy.buckets + 1;
    let failures = 0;
    let total = 0;

    for (const bucket of entry.buckets) {
      if (bucket.epoch < oldest) continue;
      failures += bucket.failed;
      total += bucket.ok + bucket.failed;
    }

    return { failures, total };
  };

  const record = (entry: KeyState, failed: boolean): void => {
    const epoch = epochNow();
    const index = ((epoch % policy.buckets) + policy.buckets) % policy.buckets;
    const bucket = entry.buckets[index];
    if (bucket === undefined) return;

    // A bucket whose epoch has rolled over is stale, not additive.
    if (bucket.epoch !== epoch) {
      bucket.epoch = epoch;
      bucket.ok = 0;
      bucket.failed = 0;
    }

    if (failed) bucket.failed++;
    else bucket.ok++;
  };

  const transition = (key: string, entry: KeyState, to: BreakerState): void => {
    if (entry.state === to) return;

    const from = entry.state;
    const { failures, total } = totals(entry);
    entry.state = to;

    if (to === 'open') entry.openedAt = clock.elapsed();
    if (to === 'closed') entry.buckets = makeWindow(policy.buckets);
    if (to !== 'half_open') entry.probeInFlight = false;

    onStateChange?.({ key, from, to, failures, total });
  };

  return {
    snapshot: (key) => {
      const entry = stateFor(key);
      return { state: entry.state, ...totals(entry) };
    },

    run: async <T>(
      key: string,
      operation: () => Promise<T>,
      describe: string,
    ): Promise<Result<T>> => {
      const entry = stateFor(key);

      if (entry.state === 'open') {
        if (clock.elapsed() - entry.openedAt < policy.resetAfter) {
          return err(unavailable(`${describe}: circuit open for ${key}`));
        }
        transition(key, entry, 'half_open');
      }

      if (entry.state === 'half_open') {
        // Exactly one probe. The point of half-open is to ask the dependency a
        // single question; letting the whole fleet through re-creates the load
        // that opened the circuit.
        if (entry.probeInFlight) {
          return err(unavailable(`${describe}: circuit probing for ${key}`));
        }
        entry.probeInFlight = true;
      }

      const probing = entry.state === 'half_open';
      const result = await attemptAsync(operation, describe);
      const failed = isErr(result) && counts(result.error);

      if (probing) {
        entry.probeInFlight = false;
        transition(key, entry, failed ? 'open' : 'closed');
        return result;
      }

      record(entry, failed);

      if (failed) {
        const { failures, total } = totals(entry);
        if (
          total >= policy.minimumThroughput &&
          failures / total >= policy.failureRatio
        ) {
          transition(key, entry, 'open');
        }
      }

      return result;
    },
  };
}
