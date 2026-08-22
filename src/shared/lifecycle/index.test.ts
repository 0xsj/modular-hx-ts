import { describe, expect, it, vi } from 'vitest';
import { fakeClock, seconds, type FakeClock } from '../clock/index.js';
import { isAppError, Kind, unavailable } from '../errors/index.js';
import { memoryLogger } from '../logger/index.js';
import { isErr, isOk } from '../result/index.js';
import { makeLifecycle, type Component, type Lifecycle } from './index.js';

/** Records what happened, in the order it happened. */
function journal() {
  const entries: string[] = [];

  const component = (
    name: string,
    behaviour: {
      readonly failStart?: boolean;
      readonly failStop?: boolean;
      readonly hangStop?: boolean;
    } = {},
  ): Component => ({
    name,
    start: () => {
      entries.push(`start ${name}`);
      if (behaviour.failStart === true) throw unavailable(`${name} is down`);
    },
    stop: async () => {
      entries.push(`stop ${name}`);
      if (behaviour.failStop === true)
        throw unavailable(`${name} will not close`);
      if (behaviour.hangStop === true) await new Promise(() => undefined);
    },
  });

  return { entries, component };
}

const build = (clock: FakeClock, options = {}): Lifecycle =>
  makeLifecycle({ clock, ...options });

/** Drive a fake clock until a promise settles, so a timeout test is instant. */
async function settle<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  const driving = (async () => {
    for (let tick = 0; tick < 40; tick++) {
      await clock.advance(seconds(5));
    }
  })();

  const result = await work;
  await driving;
  return result;
}

describe('start', () => {
  it('starts in registration order', async () => {
    const { entries, component } = journal();
    const life = build(fakeClock());

    life
      .add(component('config'))
      .add(component('database'))
      .add(component('http'));
    const started = await life.start();

    expect(isOk(started)).toBe(true);
    expect(entries).toEqual(['start config', 'start database', 'start http']);
    expect(life.state).toBe('running');
  });

  it('accepts a component with no start', async () => {
    // A pool handed in already open only needs tearing down.
    const stop = vi.fn();
    const life = build(fakeClock()).add({ name: 'pool', stop });

    expect(isOk(await life.start())).toBe(true);
    await life.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('refuses to register after starting', async () => {
    const life = build(fakeClock());
    await life.start();

    expect(() => life.add({ name: 'late', start: () => undefined })).toThrow();
  });
});

describe('stop', () => {
  it('stops in reverse order', async () => {
    // The property the module exists for: the last thing up is the first down,
    // so nothing is torn out from under something still using it.
    const { entries, component } = journal();
    const life = build(fakeClock());

    life
      .add(component('config'))
      .add(component('database'))
      .add(component('http'));
    await life.start();
    entries.length = 0;

    await life.stop('test');

    expect(entries).toEqual(['stop http', 'stop database', 'stop config']);
    expect(life.state).toBe('stopped');
  });

  it('is idempotent, because a second signal is not a second shutdown', async () => {
    const { entries, component } = journal();
    const life = build(fakeClock()).add(component('database'));
    await life.start();
    entries.length = 0;

    await Promise.all([life.stop('first'), life.stop('second')]);
    await life.stop('third');

    expect(entries).toEqual(['stop database']);
  });

  it('does nothing when nothing started', async () => {
    const life = build(fakeClock());

    expect(isOk(await life.stop())).toBe(true);
  });

  it('keeps going when a component fails to stop', async () => {
    // One that will not close is no reason to leak the rest.
    const { entries, component } = journal();
    const life = build(fakeClock());

    life
      .add(component('config'))
      .add(component('database', { failStop: true }))
      .add(component('http'));
    await life.start();
    entries.length = 0;

    const stopped = await life.stop('test');

    expect(entries).toEqual(['stop http', 'stop database', 'stop config']);
    expect(isErr(stopped)).toBe(true);
    expect(isErr(stopped) && stopped.error.kind).toBe(Kind.Internal);
    expect(isErr(stopped) && stopped.error.message).toContain(
      '1 component failed to stop',
    );
  });

  it('reports every failure, not just the first', async () => {
    const { component } = journal();
    const life = build(fakeClock());

    life
      .add(component('a', { failStop: true }))
      .add(component('b', { failStop: true }));
    await life.start();

    const stopped = await life.stop('test');

    expect(isErr(stopped) && stopped.error.message).toContain(
      '2 components failed to stop',
    );
  });

  it('resolves `stopped()` whatever started the shutdown', async () => {
    const { component } = journal();
    const life = build(fakeClock()).add(component('database'));
    await life.start();

    const waiting = life.stopped();
    await life.stop('test');

    await expect(waiting).resolves.toBeUndefined();
  });
});

describe('a failed start unwinds', () => {
  it('stops what already started, in reverse order', async () => {
    // A half-started process holds ports and locks that nothing will release,
    // which is worse than a stopped one.
    const { entries, component } = journal();
    const life = build(fakeClock());

    life
      .add(component('config'))
      .add(component('database'))
      .add(component('http', { failStart: true }))
      .add(component('worker'));

    const started = await life.start();

    expect(isErr(started)).toBe(true);
    expect(entries).toEqual([
      'start config',
      'start database',
      'start http',
      // `http` never finished starting, so it is never stopped. `worker` never
      // ran at all.
      'stop database',
      'stop config',
    ]);
  });

  it('reports why, with the original failure intact', async () => {
    const { component } = journal();
    const life = build(fakeClock()).add(
      component('database', { failStart: true }),
    );

    const started = await life.start();

    expect(isErr(started) && started.error.message).toBe(
      'start: start database: database is down',
    );
    // The kind survives the wrap, so the reason is still queryable.
    expect(isErr(started) && started.error.kind).toBe(Kind.Unavailable);
  });
});

describe('nothing hangs forever', () => {
  it('abandons a component that will not stop', async () => {
    // A process that refuses to exit gets SIGKILL and loses everything the
    // others were about to finish cleanly.
    const clock = fakeClock();
    const { entries, component } = journal();
    const life = build(clock, { stopTimeout: seconds(5) });

    life
      .add(component('config'))
      .add(component('database', { hangStop: true }));
    await life.start();
    entries.length = 0;

    const stopped = await settle(clock, life.stop('test'));

    // `config` still got its turn after `database` was given up on.
    expect(entries).toEqual(['stop database', 'stop config']);
    expect(isErr(stopped) && stopped.error.message).toContain('failed to stop');
  });

  it('says it timed out rather than that it failed', async () => {
    // The step may still be running — nothing can interrupt code that ignores
    // a deadline — so the word matters. "failed" would claim knowledge the
    // process does not have.
    const clock = fakeClock();
    const log = memoryLogger({ clock: fakeClock() });
    const { component } = journal();

    const life = makeLifecycle({
      clock,
      reporter: log,
      stopTimeout: seconds(5),
    }).add(component('database', { hangStop: true }));
    await life.start();

    await settle(clock, life.stop('test'));

    const failure = log
      .records()
      .find((record) => record.msg === 'component failed to stop');

    expect(failure?.fields['error']).toContain('timed out after 5000ms');
    expect(failure?.fields['error']).not.toContain('failed to stop database');
  });

  it('gives up entirely once the grace period is spent', async () => {
    const clock = fakeClock();
    const { entries, component } = journal();
    const life = build(clock, {
      stopTimeout: seconds(5),
      graceTimeout: seconds(6),
    });

    life
      .add(component('a'))
      .add(component('b', { hangStop: true }))
      .add(component('c', { hangStop: true }));
    await life.start();
    entries.length = 0;

    await settle(clock, life.stop('test'));

    // `c` and `b` each burned five seconds; the budget ran out before `a`.
    expect(entries).not.toContain('stop a');
  });
});

describe('reporting', () => {
  it('narrates the shutdown, because it is the only record of one', async () => {
    const clock = fakeClock();
    const log = memoryLogger({ clock });
    const { component } = journal();

    const life = makeLifecycle({ clock, reporter: log })
      .add(component('config'))
      .add(component('database'));

    await life.start();
    await life.stop('SIGTERM');

    const messages = log.records().map((r) => r.msg);
    expect(messages).toContain('started');
    expect(messages).toContain('stopping');
    expect(messages).toContain('stopped');
    expect(log.records().some((r) => r.fields['reason'] === 'SIGTERM')).toBe(
      true,
    );
  });

  it('reports a component that failed with its error', async () => {
    const clock = fakeClock();
    const log = memoryLogger({ clock });
    const { component } = journal();

    const life = makeLifecycle({ clock, reporter: log }).add(
      component('database', { failStop: true }),
    );
    await life.start();
    await life.stop('test');

    const failure = log
      .records()
      .find((r) => r.msg === 'component failed to stop');

    expect(failure?.fields['component']).toBe('database');
    // The logger promotes it, so the taxonomy survives into the line.
    expect(failure?.fields['err_kind']).toBe(Kind.Unavailable);
  });

  it('says nothing at all without a reporter', async () => {
    // The default is silence, not console output: a library that prints
    // without being asked is one nobody can embed.
    const life = build(fakeClock()).add({
      name: 'quiet',
      start: () => undefined,
    });

    expect(isOk(await life.start())).toBe(true);
  });
});

describe('signals', () => {
  it('stops on SIGTERM and removes its handlers afterwards', async () => {
    const { entries, component } = journal();
    const life = build(fakeClock()).add(component('database'));
    await life.start();
    entries.length = 0;

    const before = process.listenerCount('SIGTERM');
    const release = life.handleSignals();
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);

    process.emit('SIGTERM');
    await life.stopped();

    expect(entries).toEqual(['stop database']);

    release();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('keeps the process alive while it waits, and lets go afterwards', async () => {
    // A signal listener does not hold Node's event loop open. Without this, a
    // process with nothing else pending exits before any signal arrives —
    // which it did, with code 13, "unsettled top-level await".
    const { component } = journal();
    const life = build(fakeClock()).add(component('database'));
    await life.start();

    const before = process
      .getActiveResourcesInfo()
      .filter((r) => r === 'Timeout');
    const release = life.handleSignals();
    const holding = process
      .getActiveResourcesInfo()
      .filter((r) => r === 'Timeout');

    expect(holding.length).toBeGreaterThan(before.length);

    release();
    const after = process
      .getActiveResourcesInfo()
      .filter((r) => r === 'Timeout');
    expect(after.length).toBe(before.length);
  });

  it('lets go once stopped, without waiting to be released', async () => {
    const { component } = journal();
    const life = build(fakeClock()).add(component('database'));
    await life.start();

    const before = process
      .getActiveResourcesInfo()
      .filter((r) => r === 'Timeout');
    life.handleSignals();

    await life.stop('test');
    await life.stopped();

    expect(
      process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length,
    ).toBe(before.length);
  });

  it('calls back when a second signal arrives', async () => {
    // The operator has stopped waiting. Ignoring that is how a hung process
    // has to be killed twice.
    const { component } = journal();
    const life = build(fakeClock()).add(component('database'));
    await life.start();

    const impatient = vi.fn();
    const release = life.handleSignals(impatient);

    process.emit('SIGINT');
    process.emit('SIGINT');
    await life.stopped();

    expect(impatient).toHaveBeenCalledOnce();
    release();
  });
});

describe('errors', () => {
  it('refuses an unnamed component, because every message uses the name', () => {
    const life = build(fakeClock());

    let thrown: unknown;
    try {
      life.add({ name: '', start: () => undefined });
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown) && thrown.kind).toBe(Kind.Internal);
  });

  it('refuses to start twice', async () => {
    const life = build(fakeClock());
    await life.start();

    await expect(life.start()).rejects.toThrow();
  });
});
