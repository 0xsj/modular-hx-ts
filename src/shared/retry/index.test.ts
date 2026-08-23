import { describe, expect, it, vi } from 'vitest';
import {
  fakeClock,
  hours,
  millis,
  seconds,
  type Millis,
} from '../clock/index.js';
import {
  type AppError,
  canceled,
  conflict,
  forbidden,
  Kind,
  timeout,
  unavailable,
} from '../errors/index.js';
import { fakeRandom } from '../random/index.js';
import { isErr, isOk, unwrap } from '../result/index.js';
import { backoffFor, DEFAULT_POLICY, makeRetry, type Policy } from './index.js';

const FAST: Policy = {
  attempts: 4,
  base: millis(50),
  cap: seconds(2),
};

/** Fails `times` times with `error`, then succeeds. */
function flaky(times: number, error: AppError, value = 'ok') {
  let calls = 0;
  const operation = (): Promise<string> => {
    calls++;
    return calls <= times ? Promise.reject(error) : Promise.resolve(value);
  };
  return { operation, calls: () => calls };
}

describe('backoffFor', () => {
  const policy: Policy = { attempts: 10, base: millis(100), cap: seconds(10) };

  it('never exceeds the exponential ceiling for that attempt', () => {
    const random = fakeRandom(3);

    for (let attempt = 1; attempt <= 8; attempt++) {
      const ceiling = Math.min(policy.cap, policy.base * 2 ** (attempt - 1));

      for (let draw = 0; draw < 200; draw++) {
        const delay = backoffFor(attempt, policy, random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('never exceeds the cap, however many attempts have failed', () => {
    const random = fakeRandom(4);

    for (const attempt of [10, 20, 40, 1_000]) {
      expect(backoffFor(attempt, policy, random)).toBeLessThanOrEqual(
        policy.cap,
      );
    }
  });

  it('does not overflow to Infinity at a large attempt count', () => {
    // 2 ** 1024 is Infinity, and Infinity reaching int() is a hang rather than
    // an error. The clamp happens before the doubling.
    expect(Number.isFinite(backoffFor(5_000, policy, fakeRandom(5)))).toBe(
      true,
    );
  });

  it('spreads across the whole window, which is what full jitter means', () => {
    // Equal jitter would put a floor at half the ceiling. Full jitter uses the
    // bottom of the window too — those early probes are what a recovering
    // dependency can absorb.
    const random = fakeRandom(11);
    const ceiling = policy.base * 2 ** 4;
    const delays = Array.from({ length: 500 }, () =>
      backoffFor(5, policy, random),
    );

    expect(Math.min(...delays)).toBeLessThan(ceiling * 0.1);
    expect(Math.max(...delays)).toBeGreaterThan(ceiling * 0.9);
  });

  it('decorrelates clients that failed at the same instant', () => {
    // The whole point: without jitter every client wakes together, and the
    // herd re-forms on the dependency that just recovered.
    const delays = new Set(
      Array.from({ length: 20 }, (_, seed) =>
        backoffFor(4, policy, fakeRandom(seed + 1)),
      ),
    );

    expect(delays.size).toBeGreaterThan(15);
  });

  it('grows with the attempt number', () => {
    const random = fakeRandom(21);
    const average = (attempt: number): number =>
      Array.from({ length: 300 }, () =>
        backoffFor(attempt, policy, random),
      ).reduce((sum, d) => sum + d, 0) / 300;

    expect(average(3)).toBeGreaterThan(average(1));
    expect(average(5)).toBeGreaterThan(average(3));
  });
});

describe('retrying', () => {
  it('does not retry, or sleep, when the first attempt succeeds', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const operation = vi.fn(() => Promise.resolve('ok'));

    const result = await retry(operation, 'load user');

    expect(unwrap(result)).toBe('ok');
    expect(operation).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
    expect(clock.elapsed()).toBe(0);
  });

  it('retries a retryable failure and returns the eventual success', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(2, unavailable('connection refused'));

    const running = retry(operation, 'load user', { policy: FAST });
    await clock.advance(seconds(30));

    expect(unwrap(await running)).toBe('ok');
    expect(calls()).toBe(3);
  });

  it('verifies an hour of backoff with no real time passing', async () => {
    // The reason clock is a port. This suite would otherwise take an hour.
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(2));
    const patient: Policy = { attempts: 8, base: seconds(30), cap: hours(1) };
    const { operation, calls } = flaky(6, timeout('deadline exceeded'));
    const startedAt = Date.now();

    const running = retry(operation, 'rebuild index', { policy: patient });
    await clock.advance(hours(24));

    expect(isOk(await running)).toBe(true);
    expect(calls()).toBe(7);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('gives up after the policy runs out, returning the last failure', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(99, unavailable('still down'));

    const running = retry(operation, 'load user', { policy: FAST });
    await clock.advance(seconds(30));
    const result = await running;

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.kind).toBe(Kind.Unavailable);
    expect(calls()).toBe(FAST.attempts);
  });

  it('attempts once when the policy says one', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(99, unavailable('down'));

    const result = await retry(operation, 'load user', {
      policy: { ...FAST, attempts: 1 },
    });

    expect(isErr(result)).toBe(true);
    expect(calls()).toBe(1);
    expect(clock.pending()).toBe(0);
  });
});

describe('kind awareness', () => {
  it('does not repeat a failure the caller has to fix', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(99, forbidden('not yours'));

    const result = await retry(operation, 'load user', { policy: FAST });

    expect(isErr(result) && result.error.kind).toBe(Kind.Forbidden);
    expect(calls()).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it('does not repeat a conflict, which reproduces itself', async () => {
    // Retrying a version mismatch without re-reading state hits the same
    // mismatch. errors.isRetryable decides this once, for retry and breaker.
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(99, conflict('version 7, expected 6'));

    await retry(operation, 'rename user', { policy: FAST });

    expect(calls()).toBe(1);
  });

  it('repeats a TIMEOUT, which is the one that separates it from a refusal', async () => {
    // **Decision 0010's first branch.** Folded into `unavailable` this passes
    // by accident; as its own `Kind` it has to be decided. A deadline that
    // fired says the work did not finish in time, and a second attempt against
    // a dependency that has since recovered is repair rather than noise.
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(
      2,
      timeout('deadline exceeded after 5s'),
    );

    const running = retry(operation, 'load user', { policy: FAST });
    await clock.advance(seconds(30));

    expect(isOk(await running)).toBe(true);
    expect(calls()).toBe(3);
  });

  it('does NOT repeat a cancellation, because the caller has already gone', async () => {
    // **Decision 0010's second branch, and the one that costs if it is wrong.**
    // Retrying spends work on somebody who is no longer listening — and under
    // a wave of client disconnects it spends it once per attempt, per
    // disconnect, at exactly the moment the fleet can least afford it.
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(99, canceled('client hung up'));

    const result = await retry(operation, 'load user', { policy: FAST });

    expect(isErr(result) && result.error.kind).toBe(Kind.Canceled);
    expect(calls()).toBe(1);
    expect(clock.elapsed()).toBe(0);
  });

  it('honours a custom predicate', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation, calls } = flaky(2, conflict('optimistic lock'));

    const running = retry(operation, 'rename user', {
      policy: { ...FAST, retryable: (error) => error.kind === Kind.Conflict },
    });
    await clock.advance(seconds(30));

    expect(isOk(await running)).toBe(true);
    expect(calls()).toBe(3);
  });
});

describe('cancellation', () => {
  it('refuses to start when the signal is already aborted', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const operation = vi.fn(() => Promise.resolve('ok'));

    const result = await retry(operation, 'load user', {
      signal: AbortSignal.abort(),
    });

    expect(isErr(result) && result.error.kind).toBe(Kind.Canceled);
    expect(operation).not.toHaveBeenCalled();
  });

  it('stops mid-backoff, and does not turn the abort into another attempt', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const controller = new AbortController();
    const { operation, calls } = flaky(99, unavailable('down'));

    const running = retry(operation, 'load user', {
      policy: FAST,
      signal: controller.signal,
    });

    // Let the first attempt fail and the first sleep begin.
    await clock.advance(millis(0));
    controller.abort();
    const result = await running;

    expect(isErr(result) && result.error.kind).toBe(Kind.Canceled);
    expect(calls()).toBe(1);
    expect(clock.pending()).toBe(0);
  });
});

describe('observability', () => {
  it('reports every wait, so a retry is not an unexplained latency spike', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const seen: { attempt: number; delay: Millis; kind: string }[] = [];
    const { operation } = flaky(2, unavailable('connection refused'));

    const running = retry(operation, 'load user', {
      policy: FAST,
      onRetry: ({ attempt, delay, error }) =>
        seen.push({ attempt, delay, kind: error.kind }),
    });
    await clock.advance(seconds(30));
    await running;

    expect(seen.map((event) => event.attempt)).toEqual([1, 2]);
    expect(seen.every((event) => event.kind === Kind.Unavailable)).toBe(true);
    expect(seen.every((event) => event.delay <= FAST.cap)).toBe(true);
  });

  it('locates the failure with the description it was given', async () => {
    const clock = fakeClock();
    const retry = makeRetry(clock, fakeRandom(1));
    const { operation } = flaky(99, unavailable('connection refused'));

    const running = retry(operation, 'query user by id', {
      policy: { ...FAST, attempts: 1 },
    });
    const result = await running;

    expect(isErr(result) && result.error.message).toBe(
      'query user by id: connection refused',
    );
  });
});

describe('DEFAULT_POLICY', () => {
  it('is sized for an in-request retry', () => {
    const worst = Array.from(
      { length: DEFAULT_POLICY.attempts - 1 },
      (_, index) =>
        Math.min(DEFAULT_POLICY.cap, DEFAULT_POLICY.base * 2 ** index),
    ).reduce((sum, delay) => sum + delay, 0);

    expect(worst).toBeLessThan(seconds(3));
  });
});
