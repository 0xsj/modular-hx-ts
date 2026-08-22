import { describe, expect, it } from 'vitest';
import {
  explain,
  fromRecord,
  load,
  sensitive,
  text,
  url,
} from '../env/index.js';
import { isErr, unwrap } from '../result/index.js';
import { fakeFileSystem, parse, resolving } from './index.js';

const resolve = (
  values: Record<string, string | undefined>,
  tree: Record<string, string | Record<string, string>> = {},
) => resolving(fromRecord(values), fakeFileSystem(tree));

describe('parse', () => {
  it('recognises both schemes', () => {
    expect(parse('file:///run/secrets/smtp')).toEqual({
      scheme: 'file',
      target: '/run/secrets/smtp',
    });
    expect(parse('env://SMTP_PASSWORD_REAL')).toEqual({
      scheme: 'env',
      target: 'SMTP_PASSWORD_REAL',
    });
  });

  it('takes a key from the fragment', () => {
    expect(parse('file:///run/secrets/smtp#password')).toEqual({
      scheme: 'file',
      target: '/run/secrets/smtp',
      key: 'password',
    });
  });

  it('leaves a literal alone', () => {
    // A password may begin with almost anything, so only the two prefixes are
    // special and a value that merely contains one is not a reference.
    for (const literal of [
      'hunter2',
      'postgres://app@localhost/app',
      'not-a-file://thing',
      'see file:///etc/passwd for details',
      '',
    ]) {
      expect(
        parse(literal),
        `expected ${literal} to be a literal`,
      ).toBeUndefined();
    }
  });

  it('refuses a reference with nothing to point at', () => {
    expect(parse('file://')).toBeUndefined();
    expect(parse('env://')).toBeUndefined();
  });
});

describe('file references', () => {
  it('reads a whole file', () => {
    const secrets = resolve(
      { SMTP_PASSWORD: 'file:///run/secrets/smtp' },
      { '/run/secrets/smtp': 'hunter2' },
    );

    expect(secrets.source.get('SMTP_PASSWORD')).toBe('hunter2');
    expect(secrets.problems()).toEqual([]);
  });

  it('strips the trailing newline a file always has', () => {
    // `echo -n` is the usual advice and the usual thing forgotten. A newline in
    // a password produces an authentication failure that looks like a wrong
    // password, which is a bad afternoon.
    const secrets = resolve(
      { P: 'file:///run/secrets/smtp' },
      { '/run/secrets/smtp': 'hunter2\n' },
    );

    expect(secrets.source.get('P')).toBe('hunter2');
  });

  it('reads a Kubernetes secret mount, which is a directory of keys', () => {
    // INFRASTRUCTURE.md §7.1: a mounted k8s Secret is exactly this reference
    // and needs no new code. It only holds if the directory form is tried
    // before the file form.
    const secrets = resolve(
      { SMTP_PASSWORD: 'file:///run/secrets/smtp#password' },
      { '/run/secrets/smtp': { password: 'hunter2', username: 'ada' } },
    );

    expect(secrets.source.get('SMTP_PASSWORD')).toBe('hunter2');
  });

  it('selects a key from a key=value file', () => {
    const secrets = resolve(
      { P: 'file:///etc/app.env#SMTP_PASSWORD' },
      { '/etc/app.env': 'SMTP_HOST=mail\nSMTP_PASSWORD=hunter2\n' },
    );

    expect(secrets.source.get('P')).toBe('hunter2');
  });

  it('selects a key from a JSON file', () => {
    const secrets = resolve(
      { P: 'file:///run/secrets/db.json#password' },
      { '/run/secrets/db.json': '{"user":"app","password":"hunter2"}' },
    );

    expect(secrets.source.get('P')).toBe('hunter2');
  });

  it('reports a missing file without guessing', () => {
    const secrets = resolve({ P: 'file:///run/secrets/absent' });

    expect(secrets.source.get('P')).toBeUndefined();
    expect(secrets.problems()).toEqual([
      {
        variable: 'P',
        message: 'file:///run/secrets/absent: no such file or directory',
      },
    ]);
  });

  it('reports a missing key', () => {
    const secrets = resolve(
      { P: 'file:///etc/app.env#ABSENT' },
      { '/etc/app.env': 'SMTP_HOST=mail\n' },
    );

    // Nothing is resolved until it is asked for, so read before inspecting.
    expect(secrets.source.get('P')).toBeUndefined();
    expect(secrets.problems()[0]?.message).toBe(
      'file:///etc/app.env#ABSENT: no such key in the file',
    );
  });

  it('never puts the file contents in the message', () => {
    // The path is safe to report. What is in it never is — an error about a
    // secret is still a log line.
    const secrets = resolve(
      { P: 'file:///run/secrets/db.json#absent' },
      { '/run/secrets/db.json': '{"password":"hunter2"}' },
    );

    secrets.source.get('P');
    expect(JSON.stringify(secrets.problems())).not.toContain('hunter2');
  });
});

describe('env references', () => {
  it('follows to another variable', () => {
    const secrets = resolve({
      SMTP_PASSWORD: 'env://SMTP_PASSWORD_REAL',
      SMTP_PASSWORD_REAL: 'hunter2',
    });

    expect(secrets.source.get('SMTP_PASSWORD')).toBe('hunter2');
  });

  it('follows a chain that ends in a file', () => {
    const secrets = resolve(
      { A: 'env://B', B: 'file:///run/secrets/smtp' },
      { '/run/secrets/smtp': 'hunter2' },
    );

    expect(secrets.source.get('A')).toBe('hunter2');
  });

  it('reports a target that is not set', () => {
    const secrets = resolve({ P: 'env://ABSENT' });

    expect(secrets.source.get('P')).toBeUndefined();
    expect(secrets.problems()[0]?.message).toBe('env://ABSENT is not set');
  });

  it('stops rather than looping forever', () => {
    // A reference pointing at itself, directly or round a ring.
    const secrets = resolve({ A: 'env://B', B: 'env://A' });

    expect(secrets.source.get('A')).toBeUndefined();
    expect(secrets.problems()[0]?.message).toContain('follows more than');
  });
});

describe('resolution is lazy', () => {
  it('resolves nothing until a value is asked for', () => {
    // Deliberate. Resolving everything up front would read files for variables
    // nobody wants, and fail on a reference this process was never going to
    // use. The cost is that `problems()` is only complete after `load`.
    const secrets = resolve({ P: 'file:///run/secrets/absent' });

    expect(secrets.problems()).toEqual([]);
    secrets.source.get('P');
    expect(secrets.problems()).toHaveLength(1);
  });
});

describe('wrapping a source', () => {
  it('passes a literal through untouched', () => {
    const secrets = resolve({ HOST: 'localhost' });

    expect(secrets.source.get('HOST')).toBe('localhost');
    expect(secrets.problems()).toEqual([]);
  });

  it('leaves an absent variable absent, without a problem', () => {
    // Nothing was asked for, so nothing failed. `env` decides whether a missing
    // value matters, which is not this module's business.
    const secrets = resolve({});

    expect(secrets.source.get('ANYTHING')).toBeUndefined();
    expect(secrets.problems()).toEqual([]);
  });

  it('keeps the names of what it wrapped', () => {
    expect([...resolve({ A: '1', B: '2' }).source.names()].sort()).toEqual([
      'A',
      'B',
    ]);
  });
});

describe('with env', () => {
  it('resolves before configuration is parsed, and env never knows', () => {
    // ARCHITECTURE.md §8, and the reason `Source` is a port.
    const secrets = resolve(
      {
        SMTP_HOST: 'mail.example.com',
        SMTP_PASSWORD: 'file:///run/secrets/smtp#password',
      },
      { '/run/secrets/smtp': { password: 'hunter2' } },
    );

    const config = unwrap(
      load(secrets.source, {
        host: text('SMTP_HOST'),
        password: sensitive('SMTP_PASSWORD'),
      }),
    );

    expect(config.host).toBe('mail.example.com');
    // Wrapped, so the resolved secret still cannot print by accident.
    expect(String(config.password)).toBe('[redacted]');
    expect(config.password.expose()).toBe('hunter2');
  });

  it('reports a broken reference alongside every other problem', () => {
    // Collected rather than thrown: throwing would abort before `env` had
    // gathered the rest, and one variable per restart is the failure mode both
    // modules exist to avoid.
    const secrets = resolve({
      SMTP_PASSWORD: 'file:///run/secrets/absent',
      DATABASE_URL: 'not a url',
    });

    const config = load(secrets.source, {
      password: sensitive('SMTP_PASSWORD'),
      database: url('DATABASE_URL'),
    });

    expect(isErr(config)).toBe(true);
    const reported = isErr(config) ? explain(config.error) : '';

    expect(reported).toContain('DATABASE_URL');
    expect(secrets.problems()[0]?.variable).toBe('SMTP_PASSWORD');
    expect(secrets.problems()[0]?.message).toContain('no such file');
  });
});
