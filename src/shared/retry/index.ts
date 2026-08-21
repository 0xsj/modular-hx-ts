/**
 * Kind-aware backoff with jitter. **L0 kernel** — pure, no I/O, no process
 * state.
 *
 * Retrying is not "try again a few times". Two decisions make it correct, and
 * both are usually missing:
 *
 * 1. **Kind-aware.** Only a failure that could plausibly succeed unchanged is
 *    worth repeating. `errors.isRetryable` decides that once, so this module
 *    and `breaker` cannot disagree — a retried `Forbidden` is four identical
 *    denials, and a retried `Conflict` reproduces the mismatch it just saw.
 * 2. **Jittered.** Backoff without jitter synchronises every client that failed
 *    at the same moment, so the recovering dependency is hit by the whole fleet
 *    in lockstep, fails again, and the herd re-forms. The sleep must be random.
 *
 * Everything it depends on is injected: `Clock` for waiting, `Random` for
 * jitter. That is what lets a test verify an hour of backoff in a millisecond.
 *
 * See `notes/techniques/retry.md`.
 */

import { invariant } from '../assert/index.js';
import { type Clock, millis, type Millis, seconds } from '../clock/index.js';
import { type AppError, canceled, isRetryable } from '../errors/index.js';
import { type Random } from '../random/index.js';
import { attemptAsync, err, isErr, type Result } from '../result/index.js';

export interface Policy {
  /** Total attempts, including the first. `1` disables retrying. */
  readonly attempts: number;

  /** The ceiling for the first retry's delay, doubling from there. */
  readonly base: Millis;

  /** No delay exceeds this, however many attempts have failed. */
  readonly cap: Millis;

  /** Which failures are worth repeating. Defaults to `errors.isRetryable`. */
  readonly retryable?: (error: AppError) => boolean;
}

/**
 * Four attempts, 50ms base, 2s cap.
 *
 * Sized for an in-request retry: the worst case is under three seconds of
 * added latency, which a caller's own deadline can absorb. Background work
 * that can afford to wait should raise both and say so at the call site.
 */
export const DEFAULT_POLICY: Policy = {
  attempts: 4,
  base: millis(50),
  cap: seconds(2),
};

export interface RetryOptions {
  readonly policy?: Policy;
  readonly signal?: AbortSignal;

  /**
   * Called before each wait. The seam telemetry needs: L0 cannot log, and a
   * retry nobody can see is a latency spike nobody can explain.
   */
  readonly onRetry?: (event: {
    readonly attempt: number;
    readonly delay: Millis;
    readonly error: AppError;
  }) => void;
}

/**
 * The delay after `attempt` failures, with **full jitter**.
 *
 * `random(0, min(cap, base × 2^(attempt-1)))` — AWS's "full jitter" from
 * *Exponential Backoff and Jitter*. The exponential part spreads load over
 * time; the random part spreads it over clients.
 *
 * Full rather than equal jitter (`half + random(0, half)`) deliberately: equal
 * jitter keeps a floor under the delay, which reads safer and leaves every
 * client's retry inside the same narrow window. Full jitter decorrelates them
 * completely, and a few clients retrying early is exactly the probe a
 * recovering dependency can absorb.
 *
 * O(1). Pure — the randomness is an argument.
 */
export function backoffFor(
  attempt: number,
  policy: Policy,
  random: Random,
): Millis {
  invariant(attempt >= 1, 'attempt is one-based');

  // Clamp before doubling: 2 ** 1024 is Infinity, and Infinity reaches int().
  const exponential = Math.min(policy.cap, policy.base * 2 ** (attempt - 1));

  return millis(random.int(Math.floor(exponential) + 1));
}

export type Retrier = <T>(
  operation: () => Promise<T>,
  describe: string,
  options?: RetryOptions,
) => Promise<Result<T>>;

/**
 * Build a retrier over an injected clock and randomness.
 *
 * `describe` becomes the wrapping context on every attempt, so a failure
 * arrives already classified and already located — `query user by id:
 * connection refused` rather than `Error`.
 */
export function makeRetry(clock: Clock, random: Random): Retrier {
  return async function retry<T>(
    operation: () => Promise<T>,
    describe: string,
    options: RetryOptions = {},
  ): Promise<Result<T>> {
    const policy = options.policy ?? DEFAULT_POLICY;
    const worthRepeating = policy.retryable ?? isRetryable;

    invariant(
      Number.isInteger(policy.attempts) && policy.attempts >= 1,
      'attempts is a positive integer',
    );
    invariant(policy.cap >= policy.base, 'cap is at least base');

    for (let attempt = 1; ; attempt++) {
      if (options.signal?.aborted === true) {
        return err(
          canceled(`${describe} canceled before attempt ${String(attempt)}`),
        );
      }

      const result = await attemptAsync(operation, describe);
      if (!isErr(result)) return result;

      const last = attempt >= policy.attempts;
      if (last || !worthRepeating(result.error)) return result;

      const delay = backoffFor(attempt, policy, random);
      options.onRetry?.({ attempt, delay, error: result.error });

      const waited = await attemptAsync(
        () => clock.sleep(delay, options.signal),
        describe,
      );
      // A cancelled sleep ends the retry; it does not become another attempt.
      if (isErr(waited)) return waited;
    }
  };
}
