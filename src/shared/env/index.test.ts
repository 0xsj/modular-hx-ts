import { describe, expect, expectTypeOf, it } from 'vitest';
import { seconds, type Millis } from '../clock/index.js';
import { Kind } from '../errors/index.js';
import { isSecret, type Secret } from '../redact/index.js';
import { isErr, unwrap } from '../result/index.js';
import {
  describe as describeConfig,
  duration,
  explain,
  flag,
  fromRecord,
  integer,
  layered,
  load,
  oneOf,
  optional,
  sensitive,
  text,
  url,
} from './index.js';

const source = (values: Record<string, string | undefined>) =>
  fromRecord(values);

const problems = (result: ReturnType<typeof load>): string[] => {
  expect(isErr(result)).toBe(true);
  return isErr(result)
    ? result.error.fields.map((f) => `${f.field} ${f.message}`)
    : [];
};

describe('all problems at once', () => {
  it('reports every bad variable in one pass', () => {
    // The whole reason this module exists. Failing on the first one means fix,
    // redeploy, fail, fix, redeploy — once per mistake.
    const result = load(source({ PORT: '80a0', LEVEL: 'shout' }), {
      port: integer('PORT'),
      level: oneOf('LEVEL', ['info', 'warn']),
      host: text('HOST'),
      timeout: duration('TIMEOUT'),
    });

    expect(problems(result)).toEqual([
      'PORT is not a whole number: 80a0',
      'LEVEL is not one of info, warn: shout',
      'HOST is required',
      'TIMEOUT is required',
    ]);
  });

  it('is one Invalid error carrying the lot', () => {
    const result = load(source({}), {
      host: text('HOST'),
      port: integer('PORT'),
    });

    expect(isErr(result) && result.error.kind).toBe(Kind.Invalid);
    expect(isErr(result) && result.error.message).toBe(
      '2 configuration problems',
    );
  });

  it('counts one properly', () => {
    const result = load(source({}), { host: text('HOST') });

    expect(isErr(result) && result.error.message).toBe(
      '1 configuration problem',
    );
  });

  it('explains itself in a form somebody can act on', () => {
    const result = load(source({ PORT: '80a0' }), {
      port: integer('PORT'),
      smtpHost: text('SMTP_HOST'),
    });

    expect(isErr(result) && explain(result.error)).toBe(
      [
        '2 configuration problems',
        '  PORT       is not a whole number: 80a0',
        '  SMTP_HOST  is required',
      ].join('\n'),
    );
  });
});

describe('readers', () => {
  it('reads text, and trims what a shell leaves behind', () => {
    const config = unwrap(
      load(source({ HOST: '  localhost\n' }), { host: text('HOST') }),
    );

    expect(config.host).toBe('localhost');
  });

  it('refuses a number that is only nearly a number', () => {
    // Truncating `8080abc` to 8080 is how a service listens on a port nobody
    // chose.
    expect(
      problems(load(source({ P: '8080abc' }), { p: integer('P') })),
    ).toEqual(['P is not a whole number: 8080abc']);
  });

  it('enforces bounds', () => {
    const bounded = { p: integer('P', { min: 1, max: 65535 }) };

    expect(problems(load(source({ P: '0' }), bounded))).toEqual([
      'P is below the minimum of 1',
    ]);
    expect(problems(load(source({ P: '70000' }), bounded))).toEqual([
      'P is above the maximum of 65535',
    ]);
    expect(unwrap(load(source({ P: '15420' }), bounded)).p).toBe(15420);
  });

  it('reads the booleans people actually write', () => {
    for (const raw of ['true', 'TRUE', '1', 'yes', 'on']) {
      expect(unwrap(load(source({ F: raw }), { f: flag('F') })).f).toBe(true);
    }
    for (const raw of ['false', '0', 'no', 'off']) {
      expect(unwrap(load(source({ F: raw }), { f: flag('F') })).f).toBe(false);
    }
  });

  it('refuses a typo rather than treating it as false', () => {
    // `FEATURE=treu` silently off is worse than a startup failure naming it.
    expect(problems(load(source({ F: 'treu' }), { f: flag('F') }))).toEqual([
      'F is not a boolean: treu',
    ]);
  });

  it('lists the alternatives when one of a set is wrong', () => {
    expect(
      problems(
        load(source({ S: 'mysql' }), {
          s: oneOf('S', ['memory', 'postgres']),
        }),
      ),
    ).toEqual(['S is not one of memory, postgres: mysql']);
  });

  it('validates a URL by parsing it', () => {
    expect(
      unwrap(
        load(source({ U: 'postgres://app@localhost:15420/app' }), {
          u: url('U'),
        }),
      ).u,
    ).toBe('postgres://app@localhost:15420/app');

    expect(problems(load(source({ U: 'not a url' }), { u: url('U') }))).toEqual(
      ['U is not a valid URL'],
    );
  });

  it('reads durations the way people write them', () => {
    const read = (raw: string): Millis =>
      unwrap(load(source({ D: raw }), { d: duration('D') })).d;

    expect(read('500ms')).toBe(500);
    expect(read('30s')).toBe(30_000);
    expect(read('2m')).toBe(120_000);
    expect(read('1h')).toBe(3_600_000);
    expect(read('250')).toBe(250);
  });

  it('refuses a duration it cannot read, and suggests the shape', () => {
    expect(
      problems(load(source({ D: '30 secs' }), { d: duration('D') })),
    ).toEqual(['D is not a duration: 30 secs (try 30s, 500ms, 2m, 1h)']);
  });
});

describe('absent values', () => {
  it('falls back when a variable is unset', () => {
    const config = unwrap(
      load(source({}), {
        port: integer('PORT', { fallback: 15430 }),
        level: oneOf('LEVEL', ['info', 'warn'], { fallback: 'info' }),
      }),
    );

    expect(config.port).toBe(15430);
    expect(config.level).toBe('info');
  });

  it('treats a blank value as unset', () => {
    // `PORT=` in a compose file is the same statement as omitting the line.
    const config = unwrap(
      load(source({ PORT: '   ' }), { port: integer('PORT', { fallback: 1 }) }),
    );

    expect(config.port).toBe(1);
  });

  it('distinguishes optional from defaulted', () => {
    // A fallback says "use this when unset". Optional says "this feature is
    // off". They are different statements and produce different types.
    const config = unwrap(
      load(source({}), {
        database: optional(url('DATABASE_URL')),
        port: integer('PORT', { fallback: 15430 }),
      }),
    );

    expect(config.database).toBeUndefined();
    expect(config.port).toBe(15430);
  });

  it('still validates an optional value that is present', () => {
    expect(
      problems(
        load(source({ DATABASE_URL: 'nope' }), {
          database: optional(url('DATABASE_URL')),
        }),
      ),
    ).toEqual(['DATABASE_URL is not a valid URL']);
  });
});

describe('secrets', () => {
  it('comes back wrapped, so it cannot print by accident', () => {
    const config = unwrap(
      load(source({ SMTP_PASSWORD: 'hunter2' }), {
        password: sensitive('SMTP_PASSWORD'),
      }),
    );

    expect(isSecret(config.password)).toBe(true);
    expect(String(config.password)).toBe('[redacted]');
    expect(JSON.stringify(config)).not.toContain('hunter2');
    expect(config.password.expose()).toBe('hunter2');
  });

  it('has no fallback, because a default credential is useless or dangerous', () => {
    expect(
      problems(load(source({}), { p: sensitive('SMTP_PASSWORD') })),
    ).toEqual(['SMTP_PASSWORD is required']);
  });

  it('is never echoed by a failure elsewhere', () => {
    const result = load(source({ SMTP_PASSWORD: 'hunter2', PORT: 'x' }), {
      password: sensitive('SMTP_PASSWORD'),
      port: integer('PORT'),
    });

    expect(isErr(result) && explain(result.error)).not.toContain('hunter2');
  });
});

describe('types', () => {
  it('infers the shape from the schema', () => {
    const config = unwrap(
      load(source({ HOST: 'localhost', SMTP_PASSWORD: 'x' }), {
        host: text('HOST'),
        port: integer('PORT', { fallback: 1 }),
        debug: flag('DEBUG', { fallback: false }),
        storage: oneOf('STORAGE', ['memory', 'postgres'], {
          fallback: 'memory',
        }),
        timeout: duration('TIMEOUT', { fallback: seconds(15) }),
        password: sensitive('SMTP_PASSWORD'),
        database: optional(url('DATABASE_URL')),
      }),
    );

    expectTypeOf(config.host).toEqualTypeOf<string>();
    expectTypeOf(config.port).toEqualTypeOf<number>();
    expectTypeOf(config.debug).toEqualTypeOf<boolean>();
    expectTypeOf(config.storage).toEqualTypeOf<'memory' | 'postgres'>();
    expectTypeOf(config.timeout).toEqualTypeOf<Millis>();
    expectTypeOf(config.password).toEqualTypeOf<Secret<string>>();
    expectTypeOf(config.database).toEqualTypeOf<string | undefined>();
  });
});

describe('sources', () => {
  it('layers, first match winning', () => {
    const config = unwrap(
      load(layered(source({ PORT: '1' }), source({ PORT: '2', HOST: 'b' })), {
        port: integer('PORT'),
        host: text('HOST'),
      }),
    );

    expect(config.port).toBe(1);
    expect(config.host).toBe('b');
  });

  it('treats an explicit undefined as absent', () => {
    expect(source({ PORT: undefined }).names()).toEqual([]);
    expect(source({ PORT: undefined }).get('PORT')).toBeUndefined();
  });
});

describe('describe', () => {
  it('lists what is set without saying what a secret is', () => {
    // The listing answers "did the deploy pick up my change", which needs no
    // credentials.
    const lines = describeConfig(
      source({ HOST: 'localhost', SMTP_PASSWORD: 'hunter2' }),
      {
        host: text('HOST'),
        password: sensitive('SMTP_PASSWORD'),
        database: optional(url('DATABASE_URL')),
      },
    );

    expect(lines).toEqual([
      'HOST=localhost',
      'SMTP_PASSWORD=set',
      'DATABASE_URL=unset',
    ]);
  });
});
