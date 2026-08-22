import { describe, expect, it, vi } from 'vitest';
import { fakeClock, millis, seconds, type FakeClock } from '../clock/index.js';
import { memoryLocks } from '../lock/index.js';
import { makeOrigins } from '../provenance/index.js';
import { fakeIds } from '../id/index.js';
import { fakeRandom } from '../random/index.js';
import { memoryTelemetry } from '../telemetry/index.js';
import { isJobName, validate, type Job } from './job.js';
import { makeScheduler, type Scheduler } from './scheduler.js';

function build(
  clock: FakeClock,
  over: Partial<Parameters<typeof makeScheduler>[0]> = {},
) {
  const telemetry = memoryTelemetry(clock);
  const scheduler = makeScheduler({
    clock,
    random: fakeRandom(),
    origins: makeOrigins(fakeIds(clock)),
    locks: memoryLocks('test'),
    telemetry,
    ...over,
  });
  return { scheduler, telemetry };
}

const job = (over: Partial<Job> = {}): Job => ({
  name: 'identity.purge',
  period: seconds(60),
  run: () => 3,
  ...over,
});

describe('job names', () => {
  it('are area.verb', () => {
    expect(isJobName('identity.purge')).toBe(true);
    expect(isJobName('outbox.relay')).toBe(true);
  });

  it('refuse anything else', () => {
    for (const bad of ['purge', 'identity.user.purge', 'Identity.purge', '']) {
      expect(isJobName(bad), bad).toBe(false);
    }
  });

  it('are validated at registration, which is boot rather than 3am', () => {
    expect(validate(job({ name: 'nope' })).ok).toBe(false);
    expect(validate(job({ period: millis(0) })).ok).toBe(false);
    expect(validate(job({ timeout: millis(0) })).ok).toBe(false);
    expect(validate(job()).ok).toBe(true);
  });
});

describe('running a job', () => {
  it('reports the count the job returned', async () => {
    // Uniform logging from a returned count, so every job reports progress the
    // same way without each one inventing a log line.
    const clock = fakeClock();
    const { scheduler } = build(clock);
    scheduler.add(job({ run: () => 7 }));

    const report = await scheduler.runNow('identity.purge');

    expect(report.outcome).toBe('ran');
    expect(report.count).toBe(7);
  });

  it('mints provenance — a job is the root of its own chain', async () => {
    // PROVENANCE.md §4, the mint row. Getting this wrong is quiet: the job
    // runs, the records are written, and nothing joins to anything.
    const clock = fakeClock();
    const { scheduler } = build(clock);
    let seen:
      | {
          request: string;
          correlation: string;
          causation: string | undefined;
          actor: string;
        }
      | undefined;

    scheduler.add(
      job({
        run: (ctx) => {
          seen = {
            request: ctx.provenance.requestId,
            correlation: ctx.provenance.correlationId,
            causation: ctx.provenance.causationId,
            actor: String(ctx.provenance.actor),
          };
          return 0;
        },
      }),
    );

    await scheduler.runNow('identity.purge');

    expect(seen?.actor).toBe('system:jobs/identity.purge');
    expect(seen?.correlation).toBe(seen?.request);
    expect(seen?.causation).toBeUndefined();
  });

  it('contains a failure rather than taking the scheduler down', async () => {
    const clock = fakeClock();
    const { scheduler } = build(clock);
    scheduler.add(
      job({
        run: () => {
          throw new Error('deliberate');
        },
      }),
    );

    const report = await scheduler.runNow('identity.purge');

    expect(report.outcome).toBe('failed');
    expect(report.error).toBe('deliberate');
  });

  it('records a span whatever happened', async () => {
    const clock = fakeClock();
    const { scheduler, telemetry } = build(clock);
    scheduler.add(job());

    await scheduler.runNow('identity.purge');

    expect(telemetry.spans()[0]?.name).toBe('job identity.purge');
    expect(telemetry.open()).toBe(0);
  });
});

describe('a job that overruns', () => {
  it('is not started again while the previous run is going', async () => {
    // An overlapping purge is two workers deleting the same rows. Skip rather
    // than wait: waiting turns one slow run into an unbounded queue that all
    // fires at once when it clears.
    const clock = fakeClock();
    const { scheduler } = build(clock);
    let started = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    scheduler.add(
      job({
        run: async () => {
          started += 1;
          await held;
          return 1;
        },
      }),
    );

    const first = scheduler.runNow('identity.purge');
    const second = await scheduler.runNow('identity.purge');

    expect(second.outcome).toBe('skipped-overlapping');
    expect(started).toBe(1);

    release();
    await first;
  });

  it('is abandoned on its timeout, and says so', async () => {
    const clock = fakeClock();
    const { scheduler } = build(clock);
    let aborted = false;

    scheduler.add(
      job({
        timeout: seconds(5),
        run: (ctx) =>
          new Promise<number>((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              aborted = true;
              resolve(0);
            });
          }),
      }),
    );

    const running = scheduler.runNow('identity.purge');
    for (let tick = 0; tick < 10; tick++) await clock.advance(seconds(1));
    const report = await running;

    expect(report.outcome).toBe('timed-out');
    // Signalled, not killed: the report says timed out rather than claiming the
    // work stopped.
    expect(aborted).toBe(true);
  });
});

describe('singleton', () => {
  it('is false by default, explicitly', async () => {
    // A cache sweep is local and every instance should do its own. Making the
    // default implicit is how a destructive job runs N times because nobody
    // wrote the flag.
    const clock = fakeClock();
    const locks = memoryLocks('shared');
    const a = build(clock, { locks }).scheduler;
    const b = build(clock, { locks }).scheduler;
    let runs = 0;

    for (const s of [a, b]) s.add(job({ run: () => ++runs && 1 }));

    await Promise.all([s1(a), s1(b)]);
    expect(runs).toBe(2);

    async function s1(s: Scheduler) {
      return s.runNow('identity.purge');
    }
  });

  it('runs once across two schedulers sharing a lock service', async () => {
    const clock = fakeClock();
    const locks = memoryLocks('shared');
    const a = build(clock, { locks }).scheduler;
    const b = build(clock, { locks }).scheduler;
    let runs = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    for (const s of [a, b]) {
      s.add(
        job({
          singleton: true,
          run: async () => {
            runs += 1;
            await held;
            return 1;
          },
        }),
      );
    }

    const first = a.runNow('identity.purge');
    const second = await b.runNow('identity.purge');

    expect(second.outcome).toBe('skipped-locked');
    expect(runs).toBe(1);

    release();
    await first;
  });
});

describe('operating it by hand', () => {
  it('lists what is registered', async () => {
    const clock = fakeClock();
    const { scheduler } = build(clock);
    scheduler.add(job()).add(job({ name: 'sessions.expire', singleton: true }));

    expect(scheduler.list().map((j) => j.name)).toEqual([
      'identity.purge',
      'sessions.expire',
    ]);
    await Promise.resolve();
  });

  it('runs one by name, outside its schedule', async () => {
    // An operator who cannot invoke a purge without waiting for its period will
    // invoke it with SQL instead.
    const clock = fakeClock();
    const { scheduler } = build(clock);
    const run = vi.fn(() => 2);
    scheduler.add(job({ run }));

    const report = await scheduler.runNow('identity.purge');

    expect(run).toHaveBeenCalledOnce();
    expect(report.count).toBe(2);
  });

  it('refuses a name it does not know', async () => {
    const clock = fakeClock();
    const { scheduler } = build(clock);
    await expect(scheduler.runNow('nope.nope')).rejects.toThrow();
  });

  it('refuses a duplicate registration', () => {
    const clock = fakeClock();
    const { scheduler } = build(clock);
    scheduler.add(job());
    expect(() => scheduler.add(job())).toThrow();
  });
});
