import { describe, expect, it } from 'vitest';
import { fakeClock, seconds } from '../clock/index.js';
import { notFound, unavailable, wrap } from '../errors/index.js';
import { fakeIds } from '../id/index.js';
import { Actor, Carrier, makeOrigins } from '../provenance/index.js';
import { secret } from '../redact/index.js';
import { unwrap } from '../result/index.js';
import {
  consoleLogger,
  jsonLogger,
  memoryLogger,
  type MemoryLogger,
} from './index.js';

const clock = (): ReturnType<typeof fakeClock> => fakeClock();

const memory = (level?: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
  memoryLogger({ clock: clock(), ...(level === undefined ? {} : { level }) });

const withProvenance = <T>(fn: () => T): T => {
  const p = makeOrigins(fakeIds(fakeClock()))
    .forRequest({ correlationId: 'corr_7f3a' })
    .withActor(unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844')))
    .withTenant('acme');

  return Carrier.run(p, fn);
};

/** The escape byte, named rather than inlined: a literal one is invisible. */
const ESC = '\u001b';

const lines = (): { write: (line: string) => void; all: string[] } => {
  const all: string[] = [];
  return { write: (line) => all.push(line), all };
};

describe('levels', () => {
  it('drops anything below the minimum', () => {
    const log = memory('warn');

    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(log.records().map((r) => r.level)).toEqual(['warn', 'error']);
  });

  it('defaults to info', () => {
    const log = memory();

    log.debug('quiet');
    log.info('loud');

    expect(log.records().map((r) => r.msg)).toEqual(['loud']);
  });

  it('answers whether a level would be emitted', () => {
    // For the case where building the fields is itself expensive.
    const log = memory('info');

    expect(log.enabled('debug')).toBe(false);
    expect(log.enabled('info')).toBe(true);
    expect(log.enabled('error')).toBe(true);
  });
});

describe('records', () => {
  it('timestamps from the injected clock, never the wall clock', async () => {
    // Rule M2. It is also what makes a log assertion deterministic.
    const ticking = fakeClock();
    const log = memoryLogger({ clock: ticking });

    log.info('first');
    await ticking.advance(seconds(90));
    log.info('second');

    expect(log.records().map((r) => r.time.toISOString())).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:01:30.000Z',
    ]);
  });

  it('carries the message and fields verbatim', () => {
    const log = memory();

    log.info('user registered', { email: 'ada@example.com', attempt: 2 });

    expect(log.records()[0]?.fields).toMatchObject({
      email: 'ada@example.com',
      attempt: 2,
    });
  });
});

describe('provenance', () => {
  it('is attached to every line, without the call site passing it', () => {
    const log = memory();

    withProvenance(() => {
      log.info('user registered');
    });

    expect(log.records()[0]?.fields).toMatchObject({
      correlation_id: 'corr_7f3a',
      actor: 'user:01a024c7-d2d6-7e71-8c87-e344e27ef844',
      tenant: 'acme',
    });
  });

  it('uses the compact actor form, because logs are the observability audience', () => {
    // PROVENANCE.md §7: of-record is the nested object, observability is this.
    const log = memory();

    withProvenance(() => {
      log.info('x');
    });

    expect(typeof log.records()[0]?.fields['actor']).toBe('string');
  });

  it('logs perfectly well with no provenance in scope', () => {
    // A log line must never crash — least of all the one being written while
    // something else is already going wrong.
    const log = memory();

    expect(() => {
      log.info('no scope here');
    }).not.toThrow();
    expect(log.records()[0]?.fields['correlation_id']).toBeUndefined();
    expect(log.records()[0]?.msg).toBe('no scope here');
  });

  it('omits absent provenance fields rather than emitting them empty', () => {
    const log = memory();

    withProvenance(() => {
      log.info('x');
    });

    expect('causation_id' in (log.records()[0]?.fields ?? {})).toBe(false);
  });
});

describe('redaction', () => {
  it('scrubs sensitive keys before anything is written', () => {
    const log = memory();

    log.info('login', { email: 'ada@example.com', password: 'hunter2' });

    expect(log.records()[0]?.fields['password']).toBe('[redacted]');
    expect(log.records()[0]?.fields['email']).toBe('ada@example.com');
  });

  it('scrubs a hyphenated header name', () => {
    const log = memory();

    log.info('upstream', { headers: { 'X-Api-Key': 'sk_live_51H8yQ' } });

    expect(JSON.stringify(log.records()[0]?.fields)).not.toContain('sk_live');
  });

  it('never prints a wrapped Secret', () => {
    const { write, all } = lines();
    const log = jsonLogger({ clock: clock(), write });

    log.info('issued', { credential: secret('sk_live_51H8yQwErTyUi') });

    expect(all[0]).not.toContain('sk_live');
    expect(all[0]).toContain('[redacted]');
  });
});

describe('errors', () => {
  it('promotes the error to `error` and `err_kind`', () => {
    // MODULES.md §2. `err_kind` is the one that matters: Kind is the whole
    // taxonomy, so `err_kind=not_found` is queryable in a way a message never
    // is — and it is the same value the edge maps to a status.
    const log = memory();

    log.error('request failed', { err: notFound('no user with that id') });

    expect(log.records()[0]?.fields).toMatchObject({
      error: 'no user with that id',
      err_kind: 'not_found',
    });
  });

  it('drops the caller’s key, so one failure is not counted twice', () => {
    const log = memory();

    log.error('request failed', { err: notFound('gone') });

    expect('err' in (log.records()[0]?.fields ?? {})).toBe(false);
  });

  it('emits a Kind, never a free-form string', () => {
    // Conformance case 50.
    const log = memory();

    for (const failure of [
      notFound('a'),
      unavailable('b'),
      wrap(new TypeError('c'), 'd'),
    ]) {
      log.error('failed', { err: failure });
    }

    expect(log.records().map((r) => r.fields['err_kind'])).toEqual([
      'not_found',
      'unavailable',
      'internal',
    ]);
  });

  it('classifies an unclassified error as internal rather than omitting it', () => {
    const log = memory();

    log.error('failed', { err: new Error('plain') });

    expect(log.records()[0]?.fields).toMatchObject({
      error: 'plain',
      err_kind: 'internal',
    });
  });

  it('emits neither field when no error was logged', () => {
    // Absent fields are omitted, not written empty.
    const log = memory();

    log.info('all well');

    expect('error' in (log.records()[0]?.fields ?? {})).toBe(false);
    expect('err_kind' in (log.records()[0]?.fields ?? {})).toBe(false);
  });

  it('carries the whole wrapped message, which is the readable part', () => {
    const { write, all } = lines();
    const log = jsonLogger({ clock: clock(), write });

    log.error('request failed', {
      err: wrap(wrap(notFound('no user'), 'query user by id'), 'load user'),
    });

    const parsed = JSON.parse(all[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['error']).toBe('load user: query user by id: no user');
    expect(parsed['err_kind']).toBe('not_found');
  });

  it('puts the stack below the line, for a person', () => {
    const { write, all } = lines();
    const log = consoleLogger({ clock: clock(), write });

    log.error('request failed', { err: notFound('no user with that id') });

    const [first, ...rest] = all[0]?.split('\n') ?? [];
    expect(first).toContain('err_kind=not_found');
    expect(rest.join('\n')).toContain('AppError');
  });

  it('keeps a second error intact rather than dismantling it', () => {
    // Only the first is promoted. The second stays a real Error, which is what
    // redactKeys used to destroy: message and stack are not enumerable.
    const log = memory();

    log.error('failed', { err: notFound('first'), cause: notFound('second') });

    const second = log.records()[0]?.fields['cause'];
    expect(second).toBeInstanceOf(Error);
    expect((second as Error).message).toBe('second');
  });
});

describe('console format', () => {
  it('aligns the level so messages line up', () => {
    const { write, all } = lines();
    const log = consoleLogger({ clock: clock(), write, level: 'trace' });

    log.info('a');
    log.error('b');

    expect(all[0]).toBe('00:00:00.000 INFO  a');
    expect(all[1]).toBe('00:00:00.000 ERROR b');
  });

  it('quotes only what would otherwise be ambiguous', () => {
    const { write, all } = lines();
    const log = consoleLogger({ clock: clock(), write });

    log.info('x', { email: 'ada@example.com', note: 'two words', empty: '' });

    expect(all[0]).toContain('email=ada@example.com');
    expect(all[0]).toContain('note="two words"');
    expect(all[0]).toContain('empty=""');
  });

  it('emits no escape codes when colour is off', () => {
    const { write, all } = lines();
    const log = consoleLogger({ clock: clock(), write, colour: false });

    log.warn('careful', { n: 1 });

    expect(all[0]).not.toContain(ESC);
  });

  it('emits them when it is on', () => {
    const { write, all } = lines();
    const log = consoleLogger({ clock: clock(), write, colour: true });

    log.warn('careful');

    expect(all[0]).toContain(`${ESC}[33m`);
    expect(all[0]).toContain(`${ESC}[0m`);
  });
});

describe('json format', () => {
  it('is one parseable object per line, with flat keys', () => {
    const { write, all } = lines();
    const log = jsonLogger({ clock: clock(), write });

    withProvenance(() => {
      log.info('user registered', { email: 'ada@example.com' });
    });

    const parsed = JSON.parse(all[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['msg']).toBe('user registered');
    expect(parsed['time']).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed['correlation_id']).toBe('corr_7f3a');
    expect(parsed['email']).toBe('ada@example.com');
  });

  it('does not let a field shadow the record’s own keys', () => {
    const { write, all } = lines();
    const log = jsonLogger({ clock: clock(), write });

    log.info('real message', { level: 'trace', msg: 'impostor', time: 'nope' });

    const parsed = JSON.parse(all[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['msg']).toBe('real message');
    expect(parsed['time']).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('child', () => {
  it('adds its fields to every line', () => {
    const log = memory();
    const worker = log.child({ queue: 'exports' });

    worker.info('claimed', { batch: 3 });

    expect(log.records()[0]?.fields).toMatchObject({
      queue: 'exports',
      batch: 3,
    });
  });

  it('nests, and the innermost wins on a clash', () => {
    const log = memory();

    log.child({ component: 'outer' }).child({ component: 'inner' }).info('x');

    expect(log.records()[0]?.fields['component']).toBe('inner');
  });

  it('lets a call site override a bound field', () => {
    const log = memory();

    log.child({ attempt: 1 }).warn('retrying', { attempt: 2 });

    expect(log.records()[0]?.fields['attempt']).toBe(2);
  });

  it('shares the parent’s buffer, so a test sees everything', () => {
    const log = memory();

    log.info('from parent');
    log.child({ a: 1 }).info('from child');

    expect(log.records()).toHaveLength(2);
  });

  it('keeps the parent’s level', () => {
    const log = memory('error');

    log.child({ a: 1 }).info('dropped');

    expect(log.records()).toHaveLength(0);
  });
});

describe('a log line never throws', () => {
  it('survives a sink that fails', () => {
    // A closed pipe or a full disk is an observability failure. Letting it
    // become an exception makes it an outage. Invariant I9: availability
    // controls fail open.
    const log = jsonLogger({
      clock: clock(),
      write: () => {
        throw new Error('EPIPE');
      },
    });

    expect(() => {
      log.info('into the void');
    }).not.toThrow();
  });

  it('survives a value that cannot be serialized', () => {
    const { write, all } = lines();
    const log = jsonLogger({ clock: clock(), write });
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic['self'] = cyclic;

    expect(() => {
      log.info('cycle', { cyclic, fn: () => 1, sym: Symbol('x') });
    }).not.toThrow();
    expect(all[0]).toContain('cycle');
  });
});

describe('memoryLogger', () => {
  it('clears', () => {
    const log: MemoryLogger = memory();

    log.info('a');
    log.clear();

    expect(log.records()).toEqual([]);
  });

  it('can render lines for the rare test that is about formatting', () => {
    const log = memory();

    log.info('rendered');

    expect(log.lines()[0]).toBe('00:00:00.000 INFO  rendered');
  });
});
