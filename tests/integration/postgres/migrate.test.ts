/**
 * Migrations, against a real PostgreSQL. **Rung 2.**
 *
 * `../../../MODULES.md` §3: *`postgres` is not ticked until `testx` can prove
 * it — migrations and tx-on-context cannot be tested without a real database.*
 * This is that proof.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../../../src/shared/errors/index.js';
import {
  checksum,
  migrate,
  type Migration,
  type MigrationSet,
} from '../../../src/shared/postgres/index.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

const createUsers: Migration = {
  context: 'identity',
  name: '0001_create_users',
  sql: 'create table users (id uuid primary key, email text not null unique)',
};

const addName: Migration = {
  context: 'identity',
  name: '0002_add_name',
  sql: 'alter table users add column display_name text',
};

const users: MigrationSet = [createUsers, addName];

integration('migrations', () => {
  let schema: Schema;

  beforeEach(async () => {
    schema = await withSchema();
  });

  afterEach(async () => {
    await schema.close();
  });

  describe('applying a set', () => {
    it('applies every migration, in order, into the schema it was given', async () => {
      // Into *this* schema, not the database's default — which is only possible
      // because the migrator takes a pool rather than finding its own connection.
      const report = await migrate(schema.db, users);

      expect(report.applied.map((a) => a.name)).toEqual([
        '0001_create_users',
        '0002_add_name',
      ]);

      const columns = await schema.db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = $1 and table_name = 'users' order by column_name`,
        [schema.name],
      );
      expect(columns.map((c) => c.column_name)).toEqual([
        'display_name',
        'email',
        'id',
      ]);
    });

    it('is idempotent — a second run applies nothing', async () => {
      await migrate(schema.db, users);
      const second = await migrate(schema.db, users);

      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toBe(2);
    });

    it('applies only what is new when the set grows', async () => {
      await migrate(schema.db, [createUsers]);
      const second = await migrate(schema.db, users);

      expect(second.applied.map((a) => a.name)).toEqual(['0002_add_name']);
    });

    it('namespaces per context, so two contexts can both have an 0001', async () => {
      const both: MigrationSet = [
        ...users,
        {
          context: 'audit',
          name: '0001_create_events',
          sql: 'create table audit_events (id bigserial primary key)',
        },
      ];

      const report = await migrate(schema.db, both);
      expect(report.applied).toHaveLength(3);

      const rows = await schema.db.query<{ context: string; name: string }>(
        'select context, name from schema_migrations order by context, name',
      );
      expect(rows).toEqual([
        { context: 'audit', name: '0001_create_events' },
        { context: 'identity', name: '0001_create_users' },
        { context: 'identity', name: '0002_add_name' },
      ]);
    });
  });

  describe('the checksum', () => {
    it('refuses a migration that was edited after it was applied', async () => {
      // The whole reason to record one: the database and the repository now
      // disagree about what was run, and every later assumption is unfounded.
      await migrate(schema.db, users);

      const edited: MigrationSet = [
        {
          ...createUsers,
          sql: 'create table users (id uuid primary key, email text)',
        },
        addName,
      ];

      const failure = await migrate(schema.db, edited).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(kindOf(failure)).toBe(Kind.Conflict);
      expect(String(failure)).toContain('forward-only');
    });

    it('is the same digest form used everywhere else', async () => {
      await migrate(schema.db, users);

      const row = await schema.db.queryRow<{ checksum: string }>(
        'select checksum from schema_migrations where name = $1',
        ['0001_create_users'],
      );
      expect(row?.checksum).toBe(checksum(createUsers.sql));
      expect(row?.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    });
  });

  describe('two instances starting together', () => {
    it('serialise on the advisory lock rather than racing', async () => {
      // N replicas deploy at once. Without the lock both would apply the same
      // migration and one would fail on a duplicate object; with it, the second
      // waits and then finds nothing to do.
      const [a, b] = await Promise.all([
        migrate(schema.db, users),
        migrate(schema.db, users),
      ]);

      // Exactly one did the work; between them the set was applied once.
      expect(a.applied.length + b.applied.length).toBe(2);
      expect(Math.min(a.applied.length, b.applied.length)).toBe(0);

      const rows = await schema.db.query('select 1 from schema_migrations');
      expect(rows).toHaveLength(2);
    });
  });

  describe('failure', () => {
    it('leaves the database exactly as it was', async () => {
      // DDL is transactional in PostgreSQL, and the whole run is one transaction,
      // so a set that fails part-way applies none of itself.
      const broken: MigrationSet = [
        createUsers,
        {
          context: 'identity',
          name: '0002_broken',
          sql: 'this is not sql',
        },
      ];

      await migrate(schema.db, broken).catch(() => undefined);

      const tables = await schema.db.query(
        `select table_name from information_schema.tables where table_schema = $1`,
        [schema.name],
      );
      expect(tables).toEqual([]);
    });

    it('keeps the failing statement’s Kind rather than flattening it', async () => {
      const failure = await migrate(schema.db, [
        {
          context: 'identity',
          name: '0001_bad_syntax',
          sql: 'create tabel oops (id int)',
        },
      ]).then(
        () => undefined,
        (error: unknown) => error,
      );

      // 42601 is a syntax error — a defect, not something a caller can act on.
      expect(kindOf(failure)).toBe(Kind.Internal);
    });
  });
});
