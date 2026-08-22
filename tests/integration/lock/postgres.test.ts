/**
 * PostgreSQL advisory locks, against a real database. **Rung 2.**
 *
 * Runs the shared contract, plus the one property the memory adapter cannot
 * express and the whole reason this adapter was chosen: **a lock survives its
 * holder dying.**
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advisoryKey, postgresLocks } from '../../../src/shared/lock/index.js';
import { lockContract } from '../../../src/shared/lock/locktest.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

const NAMESPACE = 'test/lock';

let schema: Schema;

/**
 * Split an advisory key the way `pg_locks` stores it.
 *
 * The single-`bigint` form lands as `classid` = the high 32 bits,
 * `objid` = the low 32 bits, `objsubid` = 1. Documented here because the test
 * below has to find one specific lock's backend and terminate it, and
 * terminating the wrong one would look like a pass.
 */
function locate(key: bigint): { classid: string; objid: string } {
  const unsigned = key < 0n ? key + (1n << 64n) : key;
  return {
    classid: (unsigned >> 32n).toString(),
    objid: (unsigned & 0xffffffffn).toString(),
  };
}

integration('postgres advisory locks', () => {
  beforeAll(async () => {
    schema = await withSchema();
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    lockContract(() => ({
      name: 'postgres',
      // Two independent clients of the same lock service. Each lease takes its
      // own session either way, so this is contention between real sessions.
      locks: () => postgresLocks(schema.db, NAMESPACE),
      other: () => postgresLocks(schema.db, NAMESPACE),
    }));
  });

  describe('a lock survives its holder dying', () => {
    it('is released when the holding backend is terminated', async () => {
      // **The property this adapter exists for**, and the one the memory
      // adapter structurally cannot demonstrate — `STORAGE=memory` is one
      // process, so there is no other process to lose.
      //
      // `pg_terminate_backend` is as close to a crash as a test can get: the
      // session ends without anything running a release. A row-with-a-TTL
      // implementation would still hold the lock here, until the TTL expired.
      const locks = postgresLocks(schema.db, NAMESPACE);
      const name = 'survives.holder-death';
      const lease = await locks.tryAcquire(name);
      expect(lease).toBeDefined();

      // Nobody else can have it while the holder lives.
      expect(
        await postgresLocks(schema.db, NAMESPACE).tryAcquire(name),
      ).toBeUndefined();

      const { classid, objid } = locate(advisoryKey(NAMESPACE, name));
      const holder = await schema.db.queryRow<{ pid: number }>(
        `select pid from pg_locks
          where locktype = 'advisory' and classid = $1 and objid = $2
            and objsubid = 1 and granted`,
        [classid, objid],
      );
      expect(holder?.pid).toBeDefined();

      await schema.db.exec('select pg_terminate_backend($1)', [holder?.pid]);

      // Free immediately: nothing swept, nothing expired, nothing noticed.
      const after = await postgresLocks(schema.db, NAMESPACE).tryAcquire(name);
      expect(after).toBeDefined();
      await after?.release();
    });

    it('is visible in pg_locks as an advisory lock while held', async () => {
      // Pins the encoding the test above depends on. If the adapter ever moved
      // to the two-int form, `classid`/`objid` would mean something else and
      // the termination test would silently target nothing.
      const locks = postgresLocks(schema.db, NAMESPACE);
      const name = 'visible.in-pg-locks';
      const lease = await locks.tryAcquire(name);

      const { classid, objid } = locate(advisoryKey(NAMESPACE, name));
      const rows = await schema.db.query(
        `select 1 from pg_locks
          where locktype = 'advisory' and classid = $1 and objid = $2
            and objsubid = 1 and granted`,
        [classid, objid],
      );

      expect(rows).toHaveLength(1);
      await lease?.release();
    });
  });

  describe('sessions are not leaked', () => {
    it('gives the connection back when the lock is not granted', async () => {
      // A failed acquire that kept its connection would exhaust the pool during
      // exactly the contended period the lock exists to handle.
      const locks = postgresLocks(schema.db, NAMESPACE);
      const name = 'no.leak-on-refusal';
      const held = await locks.tryAcquire(name);

      const other = postgresLocks(schema.db, NAMESPACE);
      for (let i = 0; i < 20; i++) {
        expect(await other.tryAcquire(name)).toBeUndefined();
      }

      // Still usable: if the twenty refusals had each kept a connection, the
      // default pool would be long gone by now.
      expect(await schema.db.queryRow('select 1 as ok')).toEqual({ ok: 1 });
      await held?.release();
    });
  });
});
