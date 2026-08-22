/**
 * The three timeouts, against a real PostgreSQL. **Rung 2.**
 *
 * PostgreSQL ships every one of them **unlimited**, which is how a single bad
 * query exhausts a pool. Asserting they are on is not enough — these assert
 * they actually fire, because a setting that is applied to the wrong session,
 * or after the first query, looks identical to one that works until the day it
 * matters.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { millis, seconds } from '../../../src/shared/clock/index.js';
import { Kind, kindOf } from '../../../src/shared/errors/index.js';
import {
  connect,
  migrate,
  type Postgres,
} from '../../../src/shared/postgres/index.js';
import { integration } from '../../testx/gate.js';
import {
  testDsn,
  withSchema,
  withSearchPath,
  type Schema,
} from '../../testx/postgres.js';

integration('guardrails', () => {
  let schema: Schema;
  const opened: Postgres[] = [];

  /** A pool on this test's schema, with guardrails of our choosing. */
  function tuned(options: Parameters<typeof connect>[0]): Postgres {
    const db = connect({
      ...options,
      dsn: withSearchPath(testDsn(), schema.name),
    });
    opened.push(db);
    return db;
  }

  beforeAll(async () => {
    schema = await withSchema();
  });

  afterEach(async () => {
    await Promise.all(opened.splice(0).map((db) => db.close()));
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('statement_timeout', () => {
    it('cancels a runaway query, as Timeout', async () => {
      const db = tuned({ dsn: '', statementTimeout: millis(200) });

      const failure = await db.query('select pg_sleep(2)').then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(kindOf(failure)).toBe(Kind.Timeout);
      // 57014 is what the server raises when it cancels for the budget.
      expect(
        (failure as { details?: Record<string, unknown> }).details,
      ).toMatchObject({ sqlstate: '57014' });
    });

    it('applies to the very first query on a connection', async () => {
      // The reason the guardrails are startup options rather than a SET issued
      // from a connect handler: a connection handed out before its SET landed
      // would run one statement unbounded, and that statement is the one most
      // likely to be the runaway.
      const db = tuned({ dsn: '', statementTimeout: millis(200) });

      const failure = await db.query('select pg_sleep(2)').then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(kindOf(failure)).toBe(Kind.Timeout);
    });

    it('is what a migration is exempt from', async () => {
      // A migration legitimately takes longer than a request.
      const db = tuned({ dsn: '', statementTimeout: millis(200) });

      const report = await migrate(db, [
        {
          context: 'slow',
          name: '0001_takes_a_while',
          sql: 'select pg_sleep(0.6)',
        },
      ]);

      expect(report.applied).toHaveLength(1);
    });
  });

  describe('lock_timeout', () => {
    it('gives up rather than queueing behind a held lock', async () => {
      const holder = tuned({ dsn: '', lockTimeout: seconds(5) });
      const waiter = tuned({ dsn: '', lockTimeout: millis(200) });

      await holder.exec('drop table if exists locked_probe');
      await holder.exec('create table locked_probe (id int)');

      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const holding = holder.withinTx(async (tx) => {
        await tx.exec('lock table locked_probe in access exclusive mode');
        await held;
      });

      const failure = await waiter
        .exec('alter table locked_probe add column v int')
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      release();
      await holding;

      expect(kindOf(failure)).toBe(Kind.Timeout);
      // 55P03 — lock_not_available.
      expect(
        (failure as { details?: Record<string, unknown> }).details,
      ).toMatchObject({ sqlstate: '55P03' });
    });

    it('a migration is NOT exempt from it', async () => {
      // The asymmetry that matters: a migration may take as long as it likes to
      // do its work, but it must not hold the deploy open while it blocks live
      // traffic waiting for a lock it is never going to get.
      const holder = tuned({ dsn: '', lockTimeout: seconds(5) });
      const migrator = tuned({
        dsn: '',
        statementTimeout: seconds(30),
        lockTimeout: millis(200),
      });

      await holder.exec('drop table if exists migrate_probe');
      await holder.exec('create table migrate_probe (id int)');

      let release = (): void => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const holding = holder.withinTx(async (tx) => {
        await tx.exec('lock table migrate_probe in access exclusive mode');
        await held;
      });

      const started = Date.now();
      const failure = await migrate(migrator, [
        {
          context: 'blocked',
          name: '0001_needs_the_lock',
          sql: 'alter table migrate_probe add column v int',
        },
      ]).then(
        () => undefined,
        (error: unknown) => error,
      );
      const took = Date.now() - started;

      release();
      await holding;

      expect(kindOf(failure)).toBe(Kind.Timeout);
      // Fast, not "eventually" — the point is that it did not wait for the lock.
      expect(took).toBeLessThan(3_000);
    });
  });

  describe('idle_in_transaction_session_timeout', () => {
    it('ends a transaction left open, rather than pinning the snapshot forever', async () => {
      // The most damaging of the three when unset: an open transaction holds its
      // locks and pins the oldest snapshot, so one stalled client blocks vacuum
      // for the whole database.
      const db = tuned({ dsn: '', idleInTransactionTimeout: millis(300) });

      const failure = await db
        .withinTx(async (tx) => {
          await tx.exec('select 1');
          // Idle inside the transaction, which is what the setting measures.
          await new Promise((resolve) => setTimeout(resolve, 900));
          await tx.exec('select 1');
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      // 25P03 — and it is FATAL, so the *session* ends, not just the statement.
      // The pool must survive that: a client that dies mid-transaction emits
      // `error` on itself, and with no listener it takes the process down.
      expect(kindOf(failure)).toBe(Kind.Timeout);
      expect(
        (failure as { details?: Record<string, unknown> }).details,
      ).toMatchObject({ sqlstate: '25P03' });

      // Still usable afterwards: the dead connection was discarded, not reused.
      expect(await db.queryRow<{ ok: number }>('select 1 as ok')).toEqual({
        ok: 1,
      });
    });
  });
});
