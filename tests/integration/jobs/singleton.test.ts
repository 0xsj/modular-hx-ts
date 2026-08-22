/**
 * The closing condition for both `jobs` and `lock`. **Rung 2.**
 *
 * > Run the scheduler twice concurrently against one database, assert the job
 * > body executed once.
 *
 * This is the test that justifies the pair existing. `Singleton: true` is what
 * lets the architecture deploy as **one Deployment with N replicas and no
 * separate cron process**, and that claim is only testable against a real
 * PostgreSQL — two in-process schedulers sharing a `Set` would prove nothing
 * about two pods sharing a database.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { seconds, systemClock } from '../../../src/shared/clock/index.js';
import { systemIds } from '../../../src/shared/id/index.js';
import { makeScheduler, type Job } from '../../../src/shared/jobs/index.js';
import { postgresLocks } from '../../../src/shared/lock/index.js';
import { makeOrigins } from '../../../src/shared/provenance/index.js';
import { systemRandom } from '../../../src/shared/random/index.js';
import { memoryTelemetry } from '../../../src/shared/telemetry/index.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

const clock = systemClock();
const random = systemRandom();
const ids = systemIds(clock, (n) => random.bytes(n));

let schema: Schema;

/** A scheduler as a separate replica would have it: its own everything. */
function replica(job: Job) {
  const scheduler = makeScheduler({
    clock,
    random,
    origins: makeOrigins(ids),
    // Its own lock client, as a separate process would have — but the same
    // database, which is the only thing the two share.
    locks: postgresLocks(schema.db, 'test/jobs'),
    telemetry: memoryTelemetry(clock),
  });
  scheduler.add(job);
  return scheduler;
}

integration('singleton jobs across replicas', () => {
  beforeAll(async () => {
    schema = await withSchema();
  });

  afterAll(async () => {
    await schema.close();
  });

  it('executes the body exactly once across two concurrent schedulers', async () => {
    let executed = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const job: Job = {
      name: 'identity.purge',
      period: seconds(60),
      singleton: true,
      run: async () => {
        executed += 1;
        // Hold the lock so the second replica genuinely overlaps rather than
        // arriving after the first has finished and released.
        await held;
        return 1;
      },
    };

    const [a, b] = [replica(job), replica(job)];

    const first = a.runNow('identity.purge');
    // Give the first one time to take the lock before the second tries.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await b.runNow('identity.purge');

    expect(second.outcome).toBe('skipped-locked');
    expect(executed).toBe(1);

    release();
    expect((await first).outcome).toBe('ran');
    expect(executed).toBe(1);

    await Promise.all([a.stop(), b.stop()]);
  });

  it('lets the next replica take it once the holder finishes', async () => {
    // The lock is a mutex, not an election: whoever is free next runs it.
    let executed = 0;
    const job: Job = {
      name: 'sessions.expire',
      period: seconds(60),
      singleton: true,
      run: () => {
        executed += 1;
        return 1;
      },
    };

    const [a, b] = [replica(job), replica(job)];

    expect((await a.runNow('sessions.expire')).outcome).toBe('ran');
    expect((await b.runNow('sessions.expire')).outcome).toBe('ran');
    expect(executed).toBe(2);

    await Promise.all([a.stop(), b.stop()]);
  });

  it('releases the lock when the job throws', async () => {
    // A singleton that leaked its lock on failure would stop the fleet running
    // that job at all — the worst outcome, arriving from the failure that was
    // supposed to be handled.
    const job: Job = {
      name: 'outbox.relay',
      period: seconds(60),
      singleton: true,
      run: () => {
        throw new Error('deliberate');
      },
    };

    const [a, b] = [replica(job), replica(job)];

    expect((await a.runNow('outbox.relay')).outcome).toBe('failed');
    // Still available: the failure did not take the lock with it.
    expect((await b.runNow('outbox.relay')).outcome).toBe('failed');

    await Promise.all([a.stop(), b.stop()]);
  });

  it('does not take a lock at all for a non-singleton job', async () => {
    // Non-singleton runs on every instance by design — a cache sweep is local.
    let executed = 0;
    const job: Job = {
      name: 'cache.sweep',
      period: seconds(60),
      run: () => {
        executed += 1;
        return 1;
      },
    };

    const [a, b] = [replica(job), replica(job)];

    await Promise.all([a.runNow('cache.sweep'), b.runNow('cache.sweep')]);

    expect(executed).toBe(2);
    await Promise.all([a.stop(), b.stop()]);
  });

  it('frees the fleet lock when an instance stops', async () => {
    // A rolling deploy must not leave the singleton locked by an instance that
    // has gone. `stop()` releases everything this instance holds.
    const job: Job = {
      name: 'orgs.reconcile',
      period: seconds(60),
      singleton: true,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 1;
      },
    };

    const a = replica(job);
    await a.runNow('orgs.reconcile');
    await a.stop();

    const b = replica(job);
    expect((await b.runNow('orgs.reconcile')).outcome).toBe('ran');
    await b.stop();
  });
});
