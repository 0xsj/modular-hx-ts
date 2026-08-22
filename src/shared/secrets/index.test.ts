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
import {
  fakeFileSystem,
  inspect,
  literal,
  parse,
  report,
  resolving,
  willBoot,
} from './index.js';

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

describe('the literal: escape', () => {
  const check = (
    values: Record<string, string | undefined>,
    tree: Record<string, string | Record<string, string>> = {},
  ): string | undefined => resolve(values, tree).source.get('SMTP_PASSWORD');

  it('returns a password that genuinely begins env://', () => {
    // MODULES.md §2. Without it the reference syntax makes a legitimate
    // credential unrepresentable, which is a worse failure than the one the
    // syntax prevents.
    expect(check({ SMTP_PASSWORD: 'literal:env://not-a-reference' })).toBe(
      'env://not-a-reference',
    );
  });

  it('returns a password that genuinely begins file://', () => {
    expect(check({ SMTP_PASSWORD: 'literal:file:///etc/passwd' })).toBe(
      'file:///etc/passwd',
    );
  });

  it('does not trim the remainder, because verbatim means verbatim', () => {
    // A reference with surrounding whitespace is a typo; a password with a
    // trailing space is a password. An escape that edited the value it was
    // protecting would be worse than no escape.
    expect(check({ SMTP_PASSWORD: 'literal:  spaced  ' })).toBe('  spaced  ');
  });

  it('strips only the first prefix, so the escape is itself escapable', () => {
    expect(check({ SMTP_PASSWORD: 'literal:literal:x' })).toBe('literal:x');
  });

  it('works at the end of a chain, not just at the top', () => {
    // The check lives inside `follow`, so a variable reached through env://
    // escapes exactly as a directly-set one does.
    expect(
      check({
        SMTP_PASSWORD: 'env://REAL',
        REAL: 'literal:env://still-a-password',
      }),
    ).toBe('env://still-a-password');
  });

  it('is a prefix, never a substring', () => {
    expect(check({ SMTP_PASSWORD: 'my-literal:value' })).toBe(
      'my-literal:value',
    );
  });

  it('is recognised on its own', () => {
    expect(literal('literal:x')).toBe('x');
    expect(literal('literal:')).toBe('');
    expect(literal('env://x')).toBeUndefined();
  });
});

describe('the check command', () => {
  const look = (
    values: Record<string, string | undefined>,
    tree: Record<string, string | Record<string, string>> = {},
  ) => inspect(fromRecord(values), Object.keys(values), fakeFileSystem(tree));

  it('names where each value comes from', () => {
    const seen = look(
      {
        FROM_FILE: 'file:///run/secrets/db',
        FROM_ENV: 'env://OTHER',
        OTHER: 'plain',
        ESCAPED: 'literal:env://password',
        INLINE: 'plain',
        BLANK: '',
      },
      { '/run/secrets/db': 'postgres://u:p@host/db' },
    );

    expect(seen.map((i) => [i.variable, i.origin])).toEqual([
      ['FROM_FILE', 'file'],
      ['FROM_ENV', 'env'],
      ['OTHER', 'inline'],
      ['ESCAPED', 'literal'],
      ['INLINE', 'inline'],
      ['BLANK', 'unset'],
    ]);
    expect(seen.every((i) => i.ok)).toBe(true);
    expect(willBoot(seen)).toBe(true);
  });

  it('prints no value, which is the whole constraint', () => {
    // A check that leaked the credential it was verifying would be worse than
    // the restart loop it replaces.
    const seen = look(
      { DATABASE_URL: 'file:///run/secrets/db' },
      { '/run/secrets/db': 'postgres://user:hunter2@host/db' },
    );

    const printed = `${report(seen)}${JSON.stringify(seen)}`;
    expect(printed).not.toContain('hunter2');
    expect(printed).toContain('file:///run/secrets/db');
  });

  it('says which reference failed and why, and refuses to boot', () => {
    const seen = look({ SMTP_PASSWORD: 'env://MISSING' });

    expect(seen[0]?.ok).toBe(false);
    expect(seen[0]?.problem).toBe('env://MISSING is not set');
    expect(willBoot(seen)).toBe(false);
    expect(report(seen)).toContain('will not boot');
  });

  it('reports every broken reference at once', () => {
    // The restart loop is the thing being replaced: one variable per restart,
    // against a deployment that is already down.
    const seen = look({
      A: 'env://MISSING_A',
      B: 'file:///run/secrets/absent',
      C: 'plain',
    });

    expect(seen.filter((i) => !i.ok).map((i) => i.variable)).toEqual([
      'A',
      'B',
    ]);
  });

  it('resolves through the same path boot uses', () => {
    // A Kubernetes directory mount is the case most likely to differ between
    // a hand-written check and the real resolver.
    const tree = { '/run/secrets/smtp': { password: 'hunter2\n' } };

    expect(look({ P: 'file:///run/secrets/smtp#password' }, tree)[0]?.ok).toBe(
      true,
    );
    expect(
      resolve({ P: 'file:///run/secrets/smtp#password' }, tree).source.get('P'),
    ).toBe('hunter2');
  });
});
