/**
 * `DB` dual satisfaction — the test `../../../MODULES.md` §3 gives by name.
 *
 * > **How you know it worked.** A repository whose signature names `DB` can be
 * > handed a pool, a transaction, or `testx`'s per-schema pool **without
 * > changing**. If swapping the query layer would change a repository's
 * > signature, the interface is in the wrong place.
 *
 * So this file defines one repository, once, and runs it against all three.
 * There is no second version for the transactional case, and that absence is
 * the assertion.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DB } from '../../../src/shared/postgres/index.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

/**
 * A repository, written the way every real one will be.
 *
 * It names `DB` and nothing else — no pool, no client, no query builder, no
 * transaction. It cannot tell which of the three it was given, and that is the
 * point.
 */
function widgets(db: DB) {
  return {
    async create(id: number, name: string): Promise<void> {
      await db.exec('insert into widgets (id, name) values ($1, $2)', [
        id,
        name,
      ]);
    },
    async byId(id: number): Promise<{ id: number; name: string } | undefined> {
      return db.queryRow<{ id: number; name: string }>(
        'select id, name from widgets where id = $1',
        [id],
      );
    },
    async all(): Promise<readonly { id: number }[]> {
      return db.query<{ id: number }>('select id from widgets order by id');
    },
  };
}

integration('DB dual satisfaction', () => {
  let schema: Schema;

  beforeAll(async () => {
    schema = await withSchema();
    await schema.db.exec(
      'create table widgets (id int primary key, name text not null)',
    );
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the same repository', () => {
    it('works when handed the pool', async () => {
      const repo = widgets(schema.db);

      await repo.create(1, 'from the pool');

      expect(await repo.byId(1)).toEqual({ id: 1, name: 'from the pool' });
    });

    it('works when handed a transaction, with no second set of methods', async () => {
      await schema.db.withinTx(async (tx) => {
        // Identical construction. The repository is not told it is in a
        // transaction, and has no way to find out.
        const repo = widgets(tx);

        await repo.create(2, 'from a transaction');

        expect(await repo.byId(2)).toEqual({
          id: 2,
          name: 'from a transaction',
        });
      });

      // And it committed.
      expect(await widgets(schema.db).byId(2)).toBeDefined();
    });

    it('works when handed testx’s per-schema pool', async () => {
      // The third of the three §3 names, and the one that only works because the
      // DSN is a parameter.
      const other = await withSchema();
      try {
        await other.db.exec(
          'create table widgets (id int primary key, name text not null)',
        );
        const repo = widgets(other.db);

        await repo.create(3, 'somewhere else entirely');

        expect(await repo.byId(3)).toEqual({
          id: 3,
          name: 'somewhere else entirely',
        });
        // Schema isolation: this row is invisible to the other schema's pool.
        expect(await widgets(schema.db).byId(3)).toBeUndefined();
      } finally {
        await other.close();
      }
    });

    it('is rolled back with its transaction, having done nothing special', async () => {
      // Transparency cuts both ways: the repository did not opt in to atomicity
      // and cannot opt out of it either.
      await schema.db
        .withinTx(async (tx) => {
          await widgets(tx).create(99, 'doomed');
          throw new Error('deliberate');
        })
        .catch(() => undefined);

      expect(await widgets(schema.db).byId(99)).toBeUndefined();
    });
  });

  describe('schema isolation', () => {
    it('gives each caller a schema of its own, so suites can run in parallel', async () => {
      const [a, b] = await Promise.all([withSchema(), withSchema()]);
      try {
        expect(a.name).not.toBe(b.name);

        await a.db.exec('create table only_in_a (id int)');
        const visible = await b.db.query(
          `select table_name from information_schema.tables
           where table_schema = $1 and table_name = 'only_in_a'`,
          [b.name],
        );

        expect(visible).toEqual([]);
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    });
  });
});
