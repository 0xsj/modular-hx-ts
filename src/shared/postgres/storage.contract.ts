/**
 * The storage-behaviour suite. **Test tooling** — rule `S3` keeps it out of
 * shipping code.
 *
 * `../../../MODULES.md` §3: divergence on the query layer is safe **exactly to
 * the degree these four are pinned.** They are the properties query builders
 * differ on and that repository suites routinely forget, so they are asserted
 * **once, at L2**, rather than rediscovered in `identity`, `audit` and `orgs`.
 *
 * **This is not the repository contract suite.** A repository suite asserts
 * *this context's* reads and writes. This one asserts *the substrate behaves
 * the same regardless of how the SQL was produced* — so it is run even with one
 * adapter, because the properties are worth pinning when nothing is being
 * compared.
 *
 * Written **before the first repository exists**, which is the only cheap
 * moment: four cases now, or eight reconciliations after eight repositories
 * have each assumed something different.
 */

import { describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../errors/index.js';
import { type DB } from './db.js';
import { type Postgres } from './pool.js';

export interface StorageUnderTest {
  /** A fresh, migrated schema. */
  readonly db: Postgres;
  /** Names the adapter in the test output, so two runs are distinguishable. */
  readonly name: string;
}

/**
 * Run the suite against one storage adapter.
 *
 * ```ts
 * storageBehaviour(() => ({ db: schema.db, name: 'pg' }));
 * ```
 */
export function storageBehaviour(subject: () => StorageUnderTest): void {
  const sut = (): StorageUnderTest => subject();

  describe('1 · NULL ordering in ORDER BY', () => {
    // The most expensive of the four to find. Postgres defaults NULLS LAST for
    // ASC and NULLS FIRST for DESC — the opposite of what most people assume —
    // and a keyset cursor over a nullable column breaks **only at a page
    // boundary**, silently, if two adapters emit different clauses.
    const seed = async (db: DB): Promise<void> => {
      await db.exec('drop table if exists nulls_probe');
      await db.exec('create table nulls_probe (id int primary key, v int)');
      await db.exec(
        'insert into nulls_probe (id, v) values (1, 10), (2, null), (3, 20)',
      );
    };

    const order = async (
      db: DB,
      clause: string,
    ): Promise<(number | null)[]> => {
      const rows = await db.query<{ v: number | null }>(
        `select v from nulls_probe order by ${clause}`,
      );
      return rows.map((row) => row.v);
    };

    it('puts NULLS LAST for ASC by default', async () => {
      const { db } = sut();
      await seed(db);
      expect(await order(db, 'v asc')).toEqual([10, 20, null]);
    });

    it('puts NULLS FIRST for DESC by default', async () => {
      // This is the asymmetry. An adapter that appends a uniform `NULLS LAST`
      // to every ordering agrees with the ASC case and disagrees here.
      const { db } = sut();
      await seed(db);
      expect(await order(db, 'v desc')).toEqual([null, 20, 10]);
    });

    it('honours an explicit override in both directions', async () => {
      // Which is what keyset pagination must do: state it, never inherit it.
      const { db } = sut();
      await seed(db);
      expect(await order(db, 'v asc nulls first')).toEqual([null, 10, 20]);
      expect(await order(db, 'v desc nulls last')).toEqual([20, 10, null]);
    });
  });

  describe('2 · SQLSTATE maps to Kind', () => {
    // A unique violation is Conflict everywhere, or the same operation returns
    // 409 in one blueprint and 500 in another — which conformance §4.1 checks.
    it('turns a unique violation into Conflict', async () => {
      const { db } = sut();
      await db.exec('drop table if exists kind_probe');
      await db.exec('create table kind_probe (id int primary key)');
      await db.exec('insert into kind_probe (id) values (1)');

      const failure = await db
        .exec('insert into kind_probe (id) values (1)')
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(failure).toBeDefined();
      expect(kindOf(failure)).toBe(Kind.Conflict);
    });

    it('turns a not-null violation into Invalid', async () => {
      const { db } = sut();
      await db.exec('drop table if exists notnull_probe');
      await db.exec(
        'create table notnull_probe (id int primary key, v int not null)',
      );

      const failure = await db
        .exec('insert into notnull_probe (id, v) values (1, null)')
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(kindOf(failure)).toBe(Kind.Invalid);
    });

    it('keeps the SQLSTATE queryable rather than only in prose', async () => {
      // The message differs between server versions and locales; the code does
      // not, which is why it is what a dashboard filters on.
      const { db } = sut();
      await db.exec('drop table if exists state_probe');
      await db.exec('create table state_probe (id int primary key)');
      await db.exec('insert into state_probe (id) values (1)');

      const failure = await db
        .exec('insert into state_probe (id) values (1)')
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(
        (failure as { details?: Record<string, unknown> }).details,
      ).toMatchObject({
        sqlstate: '23505',
      });
    });
  });

  describe('3 · transaction isolation, and whether one is opened implicitly', () => {
    // Two adapters differing here behave differently under concurrency and
    // identically in every single-threaded test — so it is asserted directly.
    it('defaults to read committed', async () => {
      const { db } = sut();
      const row = await db.queryRow<{ transaction_isolation: string }>(
        'show transaction_isolation',
      );
      expect(row?.transaction_isolation).toBe('read committed');
    });

    it('does not open a transaction implicitly', async () => {
      // The version of this test that asserts `pg_backend_pid() is not null`
      // cannot fail and proves nothing. What distinguishes an adapter that
      // silently opens a transaction spanning statements is whether an earlier
      // statement survives a later failure: inside one it would be rolled back.
      const { db } = sut();
      await db.exec('drop table if exists implicit_probe');
      await db.exec('create table implicit_probe (id int primary key)');

      await db.exec('insert into implicit_probe (id) values (1)');
      await db
        .exec('insert into implicit_probe (id) values (1)')
        .catch(() => undefined); // 23505, deliberately

      const rows = await db.query('select id from implicit_probe');
      expect(rows).toHaveLength(1);
    });

    it('rolls back everything when the callback throws', async () => {
      const { db } = sut();
      await db.exec('drop table if exists tx_probe');
      await db.exec('create table tx_probe (id int primary key)');

      await db
        .withinTx(async (tx) => {
          await tx.exec('insert into tx_probe (id) values (1)');
          throw new Error('deliberate');
        })
        .catch(() => undefined);

      const rows = await db.query('select id from tx_probe');
      expect(rows).toEqual([]);
    });
  });

  describe('4 · timestamp precision and timezone survive a round trip', () => {
    // A value written and read back must be the same instant. Drivers differ
    // on microseconds and on whether a zone survives.
    it('returns the same instant, to the microsecond', async () => {
      const { db } = sut();
      await db.exec('drop table if exists ts_probe');
      await db.exec(
        'create table ts_probe (id int primary key, at timestamptz)',
      );

      // Deliberately not a round number of milliseconds.
      const written = '2026-08-22T10:11:12.123456+00:00';
      await db.exec(
        'insert into ts_probe (id, at) values (1, $1::timestamptz)',
        [written],
      );

      const row = await db.queryRow<{ iso: string }>(
        `select to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as iso
         from ts_probe where id = 1`,
      );
      expect(row?.iso).toBe('2026-08-22T10:11:12.123456');
    });

    it('reads back as a Date at the same instant', async () => {
      // What the driver actually hands a repository. JavaScript Dates carry
      // milliseconds, so this asserts the instant, not the precision.
      const { db } = sut();
      await db.exec('drop table if exists ts_probe2');
      await db.exec(
        'create table ts_probe2 (id int primary key, at timestamptz)',
      );

      const at = new Date('2026-08-22T10:11:12.123Z');
      await db.exec('insert into ts_probe2 (id, at) values (1, $1)', [at]);

      const row = await db.queryRow<{ at: Date }>(
        'select at from ts_probe2 where id = 1',
      );
      expect(row?.at).toBeInstanceOf(Date);
      expect(row?.at.toISOString()).toBe('2026-08-22T10:11:12.123Z');
    });

    it('is the same instant whatever zone it was written in', async () => {
      // The zone is not stored — timestamptz is an instant. An adapter that
      // preserved a zone would be storing something else.
      const { db } = sut();
      await db.exec('drop table if exists ts_probe3');
      await db.exec(
        'create table ts_probe3 (id int primary key, at timestamptz)',
      );

      await db.exec(
        'insert into ts_probe3 (id, at) values (1, $1::timestamptz), (2, $2::timestamptz)',
        ['2026-08-22T12:00:00+02:00', '2026-08-22T10:00:00+00:00'],
      );

      const row = await db.queryRow<{ same: boolean }>(
        'select (select at from ts_probe3 where id = 1) = (select at from ts_probe3 where id = 2) as same',
      );
      expect(row?.same).toBe(true);
    });
  });
}
