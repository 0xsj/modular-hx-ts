import { describe, expect, it } from 'vitest';
import { millis, seconds } from '../clock/index.js';
import { Kind } from '../errors/index.js';
import {
  checksum,
  DEFAULTS,
  dsnWithGuardrails,
  guardrails,
  kindForSqlState,
  sqlStateOf,
} from './index.js';

const DSN = 'postgres://app:app@localhost:15420/app';

describe('SQLSTATE maps to Kind', () => {
  it('makes a unique violation a Conflict, everywhere', () => {
    // Conformance §4.1: the same operation must not return 409 in one
    // blueprint and 500 in another.
    expect(kindForSqlState('23505')).toBe(Kind.Conflict);
  });

  it('makes the retryable failures retryable, by kind', () => {
    // `isRetryable` is true for exactly Unavailable and Timeout, so mapping a
    // serialization failure or a deadlock to Conflict would tell `retry` to
    // stop — on the two failures that most want retrying.
    expect(kindForSqlState('40001')).toBe(Kind.Unavailable); // serialization
    expect(kindForSqlState('40P01')).toBe(Kind.Unavailable); // deadlock
  });

  it('separates the two timeouts from the two exhaustions', () => {
    expect(kindForSqlState('55P03')).toBe(Kind.Timeout); // lock_timeout
    expect(kindForSqlState('57014')).toBe(Kind.Timeout); // statement_timeout
    expect(kindForSqlState('25P03')).toBe(Kind.Timeout); // idle_in_transaction
    // Not retryable by kind: hammering a full pool is how a bad minute becomes
    // a bad hour.
    expect(kindForSqlState('53300')).toBe(Kind.Exhausted); // too_many_connections
  });

  it('treats the whole 08 class as Unavailable', () => {
    // A connection that dropped is the same answer whichever way it dropped.
    for (const code of ['08000', '08003', '08006', '08P01']) {
      expect(kindForSqlState(code)).toBe(Kind.Unavailable);
    }
  });

  it('is Internal for anything it has not thought about', () => {
    // A SQLSTATE nobody has considered is a bug in the query, not a condition
    // a caller can act on. Guessing something friendlier turns a defect into a
    // 4xx nobody investigates.
    expect(kindForSqlState('42601')).toBe(Kind.Internal); // syntax_error
    expect(kindForSqlState('XX000')).toBe(Kind.Internal);
    expect(kindForSqlState(undefined)).toBe(Kind.Internal);
  });

  it('reads a code off a driver error and nothing else', () => {
    expect(sqlStateOf({ code: '23505' })).toBe('23505');
    expect(sqlStateOf(new Error('plain'))).toBeUndefined();
    expect(sqlStateOf({ code: 42 })).toBeUndefined();
    expect(sqlStateOf(null)).toBeUndefined();
  });
});

describe('guardrails', () => {
  it('are all three on with no configuration at all', () => {
    // PostgreSQL ships every one unlimited. A blueprint whose timeouts must be
    // opted into ships the same outage every project ships.
    const rails = guardrails({ dsn: DSN });

    expect(rails).toEqual(DEFAULTS);
    expect(rails.statementTimeout).toBeGreaterThan(0);
    expect(rails.lockTimeout).toBeGreaterThan(0);
    expect(rails.idleInTransactionTimeout).toBeGreaterThan(0);
  });

  it('makes the lock budget the shortest, because lock waits queue', () => {
    expect(DEFAULTS.lockTimeout).toBeLessThan(DEFAULTS.statementTimeout);
  });

  it('takes an override per setting', () => {
    expect(guardrails({ dsn: DSN, lockTimeout: seconds(1) }).lockTimeout).toBe(
      1_000,
    );
  });
});

describe('the DSN carries the guardrails', () => {
  it('appends them as libpq startup options', () => {
    // Startup options rather than `SET` on a connect handler: the server
    // applies them before the session accepts its first query, so there is no
    // window in which a statement runs unbounded.
    const dsn = dsnWithGuardrails(DSN, guardrails({ dsn: DSN }));
    const options = new URL(dsn).searchParams.get('options') ?? '';

    expect(options).toContain('-c statement_timeout=15000');
    expect(options).toContain('-c lock_timeout=5000');
    expect(options).toContain('-c idle_in_transaction_session_timeout=30000');
  });

  it('merges with what is already there rather than overwriting it', () => {
    // `testx` puts `search_path` in the same parameter to get a schema per
    // test. Overwriting would leave every test on the default schema while
    // appearing to have its own — silent, and it would look like flakiness.
    const withSchema = `${DSN}?options=-c%20search_path%3Dtest_42`;
    const options =
      new URL(
        dsnWithGuardrails(withSchema, guardrails({ dsn: withSchema })),
      ).searchParams.get('options') ?? '';

    expect(options).toContain('search_path=test_42');
    expect(options).toContain('statement_timeout=15000');
  });

  it('keeps everything else about the DSN intact', () => {
    const url = new URL(dsnWithGuardrails(DSN, guardrails({ dsn: DSN })));

    expect(url.hostname).toBe('localhost');
    expect(url.port).toBe('15420');
    expect(url.pathname).toBe('/app');
    expect(url.username).toBe('app');
  });

  it('leaves a keyword/value DSN alone rather than guessing', () => {
    // libpq accepts `host=... port=...` too. A second parser for a form this
    // repository does not use would be a place to be wrong, and being wrong
    // here silently disables every timeout.
    const kv = 'host=localhost port=15420 dbname=app';
    expect(dsnWithGuardrails(kv, guardrails({ dsn: kv }))).toBe(kv);
  });

  it('honours a custom budget', () => {
    const dsn = dsnWithGuardrails(
      DSN,
      guardrails({ dsn: DSN, statementTimeout: millis(250) }),
    );
    expect(dsn).toContain('statement_timeout%3D250');
  });
});

describe('migration checksums', () => {
  it('are the same digest form as everywhere else in the repo', () => {
    expect(checksum('create table t (id int)')).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  it('change when a single character does', () => {
    // Which is the whole reason to record one: an edited migration means the
    // database and the repository disagree about what was run.
    expect(checksum('create table t (id int)')).not.toBe(
      checksum('create table t (id bigint)'),
    );
  });

  it('are stable across calls', () => {
    expect(checksum('select 1')).toBe(checksum('select 1'));
  });
});
