import { describe, expect, it, vi } from 'vitest';
import { fakeClock, seconds, type FakeClock } from '../clock/index.js';
import { Kind, unavailable } from '../errors/index.js';
import {
  makeHealth,
  servesTraffic,
  statusCode,
  type Check,
  type Health,
} from './index.js';

const ok = (name: string, importance: 'critical' | 'optional'): Check => ({
  name,
  importance,
  run: () => undefined,
});

const failing = (name: string, importance: 'critical' | 'optional'): Check => ({
  name,
  importance,
  run: () => {
    throw unavailable(`${name} is unreachable`);
  },
});

const hanging = (name: string, importance: 'critical' | 'optional'): Check => ({
  name,
  importance,
  run: () => new Promise<void>(() => undefined),
});

const build = (clock: FakeClock, options = {}): Health =>
  makeHealth({ clock, ttl: seconds(0), ...options });

/** Drive a fake clock so a timeout resolves without real waiting. */
async function settle<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  const driving = (async () => {
    for (let tick = 0; tick < 20; tick++) await clock.advance(seconds(1));
  })();
  const result = await work;
  await driving;
  return result;
}

describe('liveness', () => {
  it('runs no checks at all', async () => {
    // Conformance 41. If liveness touched the database, a database blip would
    // restart every pod at once, they would all reconnect together, and a bad
    // minute would become a bad hour.
    const clock = fakeClock();
    const run = vi.fn();
    const health = build(clock).add({
      name: 'database',
      importance: 'critical',
      run,
    });

    const report = health.live();

    expect(run).not.toHaveBeenCalled();
    expect(report.checks).toEqual([]);
    expect(report.status).toBe('healthy');
    await Promise.resolve();
  });

  it('stays alive even when every dependency is down', () => {
    // The process is not broken. Restarting it would fix nothing.
    const health = build(fakeClock())
      .add(failing('database', 'critical'))
      .add(failing('cache', 'optional'));

    expect(health.live().status).toBe('healthy');
    expect(servesTraffic(health.live())).toBe(true);
  });
});

describe('readiness', () => {
  it('is healthy when everything passes', async () => {
    const health = build(fakeClock())
      .add(ok('database', 'critical'))
      .add(ok('cache', 'optional'));

    const report = await health.ready();

    expect(report.status).toBe('healthy');
    expect(report.checks.map((c) => c.name)).toEqual(['database', 'cache']);
    expect(report.checks.every((c) => c.healthy)).toBe(true);
  });

  it('is healthy with no checks registered', async () => {
    // A process with no dependencies is ready. Nothing to prove.
    expect((await build(fakeClock()).ready()).status).toBe('healthy');
  });

  it('leaves the pool when a critical dependency fails', async () => {
    const health = build(fakeClock()).add(failing('database', 'critical'));

    const report = await health.ready();

    expect(report.status).toBe('unhealthy');
    expect(servesTraffic(report)).toBe(false);
    expect(statusCode(report)).toBe(503);
  });

  it('stays in the pool when an optional dependency fails', async () => {
    // Conformance 42, and the whole point of the module. Failing readiness on
    // a backlog routes traffic to the instances already behind on the same
    // queue — which is precisely the wrong direction.
    const health = build(fakeClock())
      .add(ok('database', 'critical'))
      .add(failing('backlog', 'optional'));

    const report = await health.ready();

    expect(report.status).toBe('degraded');
    expect(servesTraffic(report)).toBe(true);
    expect(statusCode(report)).toBe(200);
  });

  it('is unhealthy when both kinds fail, because critical wins', async () => {
    const health = build(fakeClock())
      .add(failing('database', 'critical'))
      .add(failing('backlog', 'optional'));

    expect((await health.ready()).status).toBe('unhealthy');
  });

  it('reports which check failed, and why', async () => {
    const health = build(fakeClock()).add(failing('database', 'critical'));

    const [check] = (await health.ready()).checks;

    expect(check?.name).toBe('database');
    expect(check?.healthy).toBe(false);
    expect(check?.error).toBe('database: database is unreachable');
    // The kind survives, so a probe response is as queryable as a log line.
    expect(check?.kind).toBe(Kind.Unavailable);
  });

  it('runs checks concurrently, not one after another', async () => {
    // A probe that took the sum of its checks would time out long before the
    // slowest one mattered.
    //
    // Asserting the *start* order proves nothing: sequential execution
    // produces `a, b, c` as well, because each pushes before it awaits. What
    // separates them is whether every check had begun before any had finished.
    const events: string[] = [];
    const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));

    const slow = (name: string): Check => ({
      name,
      importance: 'optional',
      run: async () => {
        events.push(`start ${name}`);
        await gate;
        events.push(`end ${name}`);
      },
    });

    const health = build(fakeClock())
      .add(slow('a'))
      .add(slow('b'))
      .add(slow('c'));

    await health.ready();

    const firstEnd = events.findIndex((event) => event.startsWith('end'));
    const starts = events.slice(0, firstEnd);

    expect(starts).toEqual(['start a', 'start b', 'start c']);
  });
});

describe('a check that will not answer', () => {
  it('is a check that failed', async () => {
    // Waiting longer only makes the probe itself time out, which the
    // orchestrator reads as a dead process.
    const clock = fakeClock();
    const health = build(clock, { timeout: seconds(2) }).add(
      hanging('database', 'critical'),
    );

    const report = await settle(clock, health.ready());

    expect(report.status).toBe('unhealthy');
    expect(report.checks[0]?.error).toBe('timed out after 2000ms');
  });

  it('does not hold up the checks beside it', async () => {
    const clock = fakeClock();
    const health = build(clock, { timeout: seconds(2) })
      .add(hanging('slow', 'optional'))
      .add(ok('database', 'critical'));

    const report = await settle(clock, health.ready());

    expect(report.status).toBe('degraded');
    expect(report.checks.find((c) => c.name === 'database')?.healthy).toBe(
      true,
    );
  });
});

describe('draining', () => {
  it('reports not-ready without stopping anything', async () => {
    // Called first in shutdown, so the load balancer stops sending work before
    // components start closing. In-flight requests then finish against a
    // process that is still fully assembled.
    const health = build(fakeClock()).add(ok('database', 'critical'));

    health.drain();
    const report = await health.ready();

    expect(health.draining).toBe(true);
    expect(report.status).toBe('unhealthy');
    expect(report.checks[0]?.name).toBe('draining');
  });

  it('runs no checks while draining, because the answer cannot change', async () => {
    const run = vi.fn();
    const health = build(fakeClock()).add({
      name: 'database',
      importance: 'critical',
      run,
    });

    health.drain();
    await health.ready();

    expect(run).not.toHaveBeenCalled();
  });

  it('stays alive, so it is not restarted mid-drain', () => {
    // Liveness must not fail here: a restart would kill the in-flight requests
    // draining exists to protect.
    const health = build(fakeClock());
    health.drain();

    expect(servesTraffic(health.live())).toBe(true);
    expect(health.live().status).toBe('degraded');
  });

  it('discards a cached ready answer immediately', async () => {
    const clock = fakeClock();
    const health = makeHealth({ clock, ttl: seconds(30) }).add(
      ok('database', 'critical'),
    );

    expect((await health.ready()).status).toBe('healthy');
    health.drain();

    expect((await health.ready()).status).toBe('unhealthy');
  });
});

describe('caching', () => {
  it('reuses an answer within the window', async () => {
    // Probes arrive from the orchestrator, the load balancer and whatever else
    // is watching. Each running a real query multiplies that load onto the
    // dependency least able to take it.
    const clock = fakeClock();
    const run = vi.fn();
    const health = makeHealth({ clock, ttl: seconds(10) }).add({
      name: 'database',
      importance: 'critical',
      run,
    });

    await health.ready();
    await health.ready();
    await health.ready();

    expect(run).toHaveBeenCalledOnce();
  });

  it('runs again once the window passes', async () => {
    const clock = fakeClock();
    const run = vi.fn();
    const health = makeHealth({ clock, ttl: seconds(10) }).add({
      name: 'database',
      importance: 'critical',
      run,
    });

    await health.ready();
    await clock.advance(seconds(11));
    await health.ready();

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('can be switched off', async () => {
    const run = vi.fn();
    const health = build(fakeClock()).add({
      name: 'database',
      importance: 'critical',
      run,
    });

    await health.ready();
    await health.ready();

    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('registration', () => {
  it('refuses a duplicate name, because a report is read by name', () => {
    const health = build(fakeClock()).add(ok('database', 'critical'));

    expect(() => health.add(ok('database', 'optional'))).toThrow();
  });

  it('refuses an unnamed check', () => {
    expect(() => build(fakeClock()).add(ok('', 'critical'))).toThrow();
  });
});
