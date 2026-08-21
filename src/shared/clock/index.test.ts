import { describe, expect, it } from 'vitest';
import { isAppError, Kind } from '../errors/index.js';
import {
  fakeClock,
  hours,
  millis,
  minutes,
  seconds,
  systemClock,
  type Millis,
} from './index.js';

const kindOfRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return isAppError(error) ? error.kind : error;
  }
  return undefined;
};

describe('Millis', () => {
  it('converts each unit to milliseconds', () => {
    expect(millis(250)).toBe(250);
    expect(seconds(30)).toBe(30_000);
    expect(minutes(5)).toBe(300_000);
    expect(hours(2)).toBe(7_200_000);
  });

  it('is a plain number at runtime', () => {
    const timeout: Millis = seconds(30);

    expect(typeof timeout).toBe('number');
    expect(timeout + 1).toBe(30_001);
    expect(JSON.stringify({ timeout })).toBe('{"timeout":30000}');
  });
});

describe('fakeClock', () => {
  it('starts at a fixed instant, so no test depends on the day it runs', () => {
    expect(fakeClock().now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(
      fakeClock(new Date('1999-12-31T23:59:59.000Z')).now().toISOString(),
    ).toBe('1999-12-31T23:59:59.000Z');
  });

  it('does not move on its own', async () => {
    const clock = fakeClock();
    const before = clock.now().getTime();

    await Promise.resolve();

    expect(clock.now().getTime()).toBe(before);
    expect(clock.monotonic()).toBe(0);
  });

  it('moves wall and monotonic time together when advanced', async () => {
    const clock = fakeClock();

    await clock.advance(minutes(90));

    expect(clock.monotonic()).toBe(5_400_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T01:30:00.000Z');
  });

  it('releases a sleep with no real time passing', async () => {
    // The whole point: a retry suite with an hour of backoff in it finishes in
    // a millisecond, and still exercises the real ordering.
    const clock = fakeClock();
    const started = Date.now();
    let woke = false;

    const sleeping = clock.sleep(hours(1)).then(() => {
      woke = true;
    });

    expect(woke).toBe(false);
    await clock.advance(hours(1));
    await sleeping;

    expect(woke).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not release a sleep that has not come due', async () => {
    const clock = fakeClock();
    let woke = false;

    void clock.sleep(seconds(30)).then(() => {
      woke = true;
    });

    await clock.advance(seconds(29));

    expect(woke).toBe(false);
    expect(clock.pending()).toBe(1);
  });

  it('releases sleeps in deadline order, then in the order they started', async () => {
    const clock = fakeClock();
    const order: string[] = [];

    void clock.sleep(seconds(2)).then(() => order.push('later'));
    void clock.sleep(seconds(1)).then(() => order.push('first-of-two'));
    void clock.sleep(seconds(1)).then(() => order.push('second-of-two'));

    await clock.advance(seconds(5));

    expect(order).toEqual(['first-of-two', 'second-of-two', 'later']);
  });

  it('releases a sleep started by a sleep it just woke', async () => {
    // Backoff loops do exactly this, and an advance that stopped at the first
    // wake would deadlock them.
    const clock = fakeClock();
    const order: string[] = [];

    void clock.sleep(seconds(1)).then(async () => {
      order.push('first');
      await clock.sleep(seconds(1));
      order.push('second');
    });

    await clock.advance(seconds(10));

    expect(order).toEqual(['first', 'second']);
  });

  it('releases a sleep registered several microtask turns after the wake', async () => {
    // Regression. `advance` used to yield a single microtask between wakes,
    // which is enough only when the woken code sleeps again immediately. A
    // retry loop wakes, awaits its operation, wraps the result, computes a
    // backoff, and *then* sleeps — and `advance` found nothing due, returned,
    // and left the caller parked forever. Found by `retry`, the fake's first
    // real consumer.
    const clock = fakeClock();
    const order: string[] = [];

    const loop = (async () => {
      for (let round = 0; round < 3; round++) {
        await clock.sleep(seconds(1));
        order.push(`woke ${String(round)}`);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    })();

    await clock.advance(seconds(10));
    await loop;

    expect(order).toEqual(['woke 0', 'woke 1', 'woke 2']);
    expect(clock.pending()).toBe(0);
  });

  it('counts outstanding sleeps, so a test can catch a leak', async () => {
    const clock = fakeClock();

    expect(clock.pending()).toBe(0);
    void clock.sleep(seconds(1));
    void clock.sleep(seconds(2));
    expect(clock.pending()).toBe(2);

    await clock.advance(seconds(5));
    expect(clock.pending()).toBe(0);
  });

  it('rejects a sleep aborted before it starts', async () => {
    const clock = fakeClock();

    expect(
      await kindOfRejection(clock.sleep(seconds(1), AbortSignal.abort())),
    ).toBe(Kind.Canceled);
    expect(clock.pending()).toBe(0);
  });

  it('rejects a sleep aborted while it waits, and stops tracking it', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(hours(1), controller.signal);

    expect(clock.pending()).toBe(1);
    controller.abort();

    expect(await kindOfRejection(sleeping)).toBe(Kind.Canceled);
    expect(clock.pending()).toBe(0);
  });
});

describe('monotonic time', () => {
  it('is unaffected by the wall clock jumping backwards', async () => {
    // The NTP correction that breaks duration measurement everywhere it is done
    // with wall-clock time. This is why the port exposes both.
    const clock = fakeClock();
    const startedAt = clock.monotonic();

    await clock.advance(seconds(10));
    clock.setWallClock(new Date('2020-01-01T00:00:00.000Z'));

    expect(clock.now().getFullYear()).toBe(2020);
    expect(clock.monotonic() - startedAt).toBe(10_000);
  });
});

describe('systemClock', () => {
  it('reports a plausible wall-clock time', () => {
    const drift = Math.abs(systemClock().now().getTime() - Date.now());

    expect(drift).toBeLessThan(1_000);
  });

  it('has a monotonic reading that never goes backwards', () => {
    const clock = systemClock();
    const readings = [clock.monotonic(), clock.monotonic(), clock.monotonic()];

    expect(readings[1]).toBeGreaterThanOrEqual(readings[0] ?? 0);
    expect(readings[2]).toBeGreaterThanOrEqual(readings[1] ?? 0);
  });

  it('actually waits', async () => {
    const clock = systemClock();
    const before = clock.monotonic();

    await clock.sleep(millis(20));

    // setTimeout may fire a hair early on some platforms; the assertion is that
    // real time passed, not that the timer is precise.
    expect(clock.monotonic() - before).toBeGreaterThanOrEqual(15);
  });

  it('rejects when aborted, before and during the wait', async () => {
    const clock = systemClock();

    expect(
      await kindOfRejection(clock.sleep(seconds(1), AbortSignal.abort())),
    ).toBe(Kind.Canceled);

    const controller = new AbortController();
    const sleeping = clock.sleep(hours(1), controller.signal);
    controller.abort();

    expect(await kindOfRejection(sleeping)).toBe(Kind.Canceled);
  });
});
