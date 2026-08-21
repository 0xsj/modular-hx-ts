import { describe, expect, it, vi } from 'vitest';
import { fakeClock, millis, seconds, type FakeClock } from '../clock/index.js';
import {
  type AppError,
  forbidden,
  Kind,
  unavailable,
} from '../errors/index.js';
import { isErr, isOk } from '../result/index.js';
import { type BreakerPolicy, type StateChange, makeBreaker } from './index.js';

const POLICY: BreakerPolicy = {
  window: seconds(10),
  buckets: 10,
  minimumThroughput: 4,
  failureRatio: 0.5,
  resetAfter: seconds(5),
};

const fail = (error: AppError) => () => Promise.reject(error);
const succeed = () => Promise.resolve('ok');
const DOWN = unavailable('connection refused');

/** Run `count` operations through the breaker, ignoring their results. */
async function drive(
  breaker: {
    run: (k: string, op: () => Promise<string>, d: string) => Promise<unknown>;
  },
  key: string,
  operations: (() => Promise<string>)[],
): Promise<void> {
  for (const operation of operations) {
    await breaker.run(key, operation, 'call dependency');
  }
}

const repeat = <T>(count: number, value: T): T[] =>
  Array.from({ length: count }, () => value);

describe('closed', () => {
  it('passes calls through and returns their results', async () => {
    const breaker = makeBreaker(fakeClock(), POLICY);

    const result = await breaker.run('api.example.com', succeed, 'call');

    expect(isOk(result)).toBe(true);
    expect(breaker.snapshot('api.example.com').state).toBe('closed');
  });

  it('does not trip below the minimum throughput', async () => {
    // Two failures out of two is a 100% failure ratio and still not evidence.
    const breaker = makeBreaker(fakeClock(), POLICY);

    await drive(breaker, 'api', repeat(2, fail(DOWN)));

    expect(breaker.snapshot('api').state).toBe('closed');
  });

  it('trips once enough recent calls have failed', async () => {
    const breaker = makeBreaker(fakeClock(), POLICY);

    await drive(breaker, 'api', repeat(4, fail(DOWN)));

    expect(breaker.snapshot('api').state).toBe('open');
  });

  it('trips on a flapping dependency, which a consecutive counter never would', async () => {
    // The reason for a rolling window. Alternating failure and success never
    // produces two failures in a row, so a consecutive-failure counter sits at
    // one forever — while half of every caller's requests hang until timeout.
    const breaker = makeBreaker(fakeClock(), POLICY);

    await drive(breaker, 'api', [
      fail(DOWN),
      succeed,
      fail(DOWN),
      succeed,
      fail(DOWN),
      succeed,
      fail(DOWN),
      succeed,
    ]);

    expect(breaker.snapshot('api').state).toBe('open');
  });

  it('ignores failures that say nothing about the dependency', async () => {
    // A 403 is not the dependency being down. errors.isRetryable decides this
    // once, for retry and breaker both.
    const breaker = makeBreaker(fakeClock(), POLICY);

    await drive(breaker, 'api', repeat(20, fail(forbidden('not yours'))));

    expect(breaker.snapshot('api').state).toBe('closed');
  });

  it('lets old failures age out of the window', async () => {
    const clock = fakeClock();
    const breaker = makeBreaker(clock, POLICY);

    await drive(breaker, 'api', repeat(3, fail(DOWN)));
    expect(breaker.snapshot('api').total).toBe(3);

    await clock.advance(seconds(11));

    expect(breaker.snapshot('api').total).toBe(0);
    await drive(breaker, 'api', repeat(3, fail(DOWN)));
    expect(breaker.snapshot('api').state).toBe('closed');
  });
});

describe('open', () => {
  const tripped = async (clock: FakeClock) => {
    const breaker = makeBreaker(clock, POLICY);
    await drive(breaker, 'api', repeat(4, fail(DOWN)));
    return breaker;
  };

  it('fails fast without calling the operation', async () => {
    const clock = fakeClock();
    const breaker = await tripped(clock);
    const operation = vi.fn(succeed);

    const result = await breaker.run('api', operation, 'call dependency');

    expect(operation).not.toHaveBeenCalled();
    expect(isErr(result) && result.error.kind).toBe(Kind.Unavailable);
    expect(isErr(result) && result.error.message).toContain('circuit open');
  });

  it('keeps failing fast until the reset window elapses', async () => {
    const clock = fakeClock();
    const breaker = await tripped(clock);

    await clock.advance(seconds(4));
    expect(isErr(await breaker.run('api', succeed, 'call'))).toBe(true);

    await clock.advance(seconds(2));
    expect(isOk(await breaker.run('api', succeed, 'call'))).toBe(true);
  });

  it('isolates keys, so one bad host does not stop the others', async () => {
    // The reason the breaker is keyed at all.
    const breaker = makeBreaker(fakeClock(), POLICY);
    await drive(breaker, 'broken.example.com', repeat(4, fail(DOWN)));

    expect(breaker.snapshot('broken.example.com').state).toBe('open');
    expect(breaker.snapshot('healthy.example.com').state).toBe('closed');
    expect(
      isOk(await breaker.run('healthy.example.com', succeed, 'call')),
    ).toBe(true);
  });
});

describe('half-open', () => {
  const trippedAndElapsed = async (
    clock: FakeClock,
    onChange?: (c: StateChange) => void,
  ) => {
    const breaker = makeBreaker(clock, POLICY, onChange);
    await drive(breaker, 'api', repeat(4, fail(DOWN)));
    await clock.advance(seconds(6));
    return breaker;
  };

  it('closes again when the probe succeeds, and forgets the old window', async () => {
    const clock = fakeClock();
    const breaker = await trippedAndElapsed(clock);

    expect(isOk(await breaker.run('api', succeed, 'call'))).toBe(true);

    const after = breaker.snapshot('api');
    expect(after.state).toBe('closed');
    // The old failures must not survive: otherwise the next single failure
    // re-trips instantly on evidence from before the outage ended.
    expect(after.failures).toBe(0);
    expect(after.total).toBe(0);
  });

  it('reopens when the probe fails, and restarts the clock', async () => {
    const clock = fakeClock();
    const breaker = await trippedAndElapsed(clock);

    expect(isErr(await breaker.run('api', fail(DOWN), 'call'))).toBe(true);
    expect(breaker.snapshot('api').state).toBe('open');

    // Still open a moment later: the reset window restarted from the probe.
    await clock.advance(seconds(4));
    const operation = vi.fn(succeed);
    await breaker.run('api', operation, 'call');
    expect(operation).not.toHaveBeenCalled();
  });

  it('admits exactly one probe, not the whole fleet', async () => {
    // Letting everyone through on reset re-creates the load that opened the
    // circuit, against a dependency that has not answered anything yet.
    const clock = fakeClock();
    const breaker = await trippedAndElapsed(clock);

    let release: (value: string) => void = () => undefined;
    const slow = (): Promise<string> =>
      new Promise((resolve) => {
        release = resolve;
      });

    const probe = breaker.run('api', slow, 'call');
    const blocked = await breaker.run('api', succeed, 'call');

    expect(isErr(blocked) && blocked.error.message).toContain(
      'circuit probing',
    );

    release('ok');
    expect(isOk(await probe)).toBe(true);
    expect(breaker.snapshot('api').state).toBe('closed');
  });
});

describe('observability', () => {
  it('reports every transition, because a control that fires invisibly is a mystery', async () => {
    // Invariant I9: the fail-open/fail-closed decision is logged when it fires.
    const clock = fakeClock();
    const changes: StateChange[] = [];
    const breaker = makeBreaker(clock, POLICY, (change) =>
      changes.push(change),
    );

    await drive(breaker, 'api', repeat(4, fail(DOWN)));
    await clock.advance(seconds(6));
    await breaker.run('api', succeed, 'call');

    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual([
      'closed->open',
      'open->half_open',
      'half_open->closed',
    ]);
    expect(changes[0]?.key).toBe('api');
    expect(changes[0]?.failures).toBe(4);
    expect(changes[0]?.total).toBe(4);
  });
});

describe('policy', () => {
  it('rejects a policy that could never be satisfied', () => {
    const clock = fakeClock();

    expect(() => makeBreaker(clock, { ...POLICY, buckets: 0 })).toThrow();
    expect(() => makeBreaker(clock, { ...POLICY, failureRatio: 0 })).toThrow();
    expect(() =>
      makeBreaker(clock, { ...POLICY, minimumThroughput: 0 }),
    ).toThrow();
  });

  it('honours a custom failure predicate', async () => {
    const breaker = makeBreaker(fakeClock(), {
      ...POLICY,
      countsAsFailure: (error) => error.kind === Kind.Forbidden,
    });

    await drive(breaker, 'api', repeat(4, fail(forbidden('not yours'))));

    expect(breaker.snapshot('api').state).toBe('open');
  });

  it('accepts a bucket count of one', async () => {
    const clock = fakeClock();
    const breaker = makeBreaker(clock, { ...POLICY, buckets: 1 });

    await drive(breaker, 'api', repeat(4, fail(DOWN)));

    expect(breaker.snapshot('api').state).toBe('open');
    await clock.advance(millis(POLICY.window + 1));
    expect(breaker.snapshot('api').total).toBe(0);
  });
});
