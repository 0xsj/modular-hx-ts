/**
 * The record store, against a real PostgreSQL. **Rung 2.**
 *
 * The shared contract, plus what only a real database can demonstrate:
 *
 * - **The claim is atomic across connections.** The memory adapter is atomic
 *   because JavaScript runs it to completion; that proves nothing about a
 *   statement racing another process. Here the concurrency is real, and
 *   read-then-write fails.
 * - **A crashed claimant is reclaimed on the database's clock.** `now()` lives
 *   inside PostgreSQL, where no injected clock reaches — which is why the
 *   contract suite waits rather than pretending.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { millis } from '../../../src/shared/clock/index.js';
import { digest, type Digest } from '../../../src/shared/digest/index.js';
import {
  type ScopedKey,
  RECORDS_TABLE,
  idempotencyMigrations,
  postgresRecords,
} from '../../../src/shared/idempotency/index.js';
import { recordsContract } from '../../../src/shared/idempotency/idempotencytest.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { unwrap } from '../../../src/shared/result/index.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;

const A: Digest = unwrap(digest({ amount: 100 }));

let counter = 0;
const nextKey = (over: Partial<ScopedKey> = {}): ScopedKey => ({
  tenant: 't_acme',
  principal: 'user:01a024c7-d2d6-7e71-8c87-e344e27ef844',
  key: `pg-${String(++counter)}`,
  ...over,
});

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RESPONSE = {
  status: 201,
  headers: { 'content-type': 'application/json' },
  body: '{"id":"pay_1"}',
};

integration('postgres idempotency records', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, idempotencyMigrations);
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    recordsContract(() => ({
      name: 'postgres',
      records: (options) => postgresRecords(schema.db, options),
    }));
  });

  describe('what only a real database proves', () => {
    it('lets exactly one of many concurrent claims through', async () => {
      // **The defect this port exists to prevent.** The pool hands each of
      // these its own connection, so they genuinely race — which is the thing
      // the in-process suite cannot demonstrate however many promises it
      // starts at once.
      const records = postgresRecords(schema.db);
      const key = nextKey();

      const outcomes = await Promise.all(
        Array.from({ length: 16 }, () => records.claim(key, A)),
      );

      expect(outcomes.filter((o) => o.outcome === 'claimed')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'in-flight')).toHaveLength(
        15,
      );
    });

    it('holds a crashed claimant`s key until the lease, then releases it', async () => {
      // The claimant never calls `complete` and never calls `release` — which
      // is what a process dying between the two looks like from here.
      const records = postgresRecords(schema.db, {
        leaseFor: millis(500),
      });
      const key = nextKey();

      expect(await records.claim(key, A)).toEqual({ outcome: 'claimed' });
      expect(await records.claim(key, A)).toEqual({ outcome: 'in-flight' });

      await wait(700);

      // Reclaimed on the **database's** clock. Without this the 409 is
      // permanent and only an operator with table access can clear it.
      expect(await records.claim(key, A)).toEqual({ outcome: 'claimed' });
    });

    it('resolves a claim that raced a commit it cannot see', async () => {
      // **The exact race that produced the defect above, forced deterministically.**
      //
      // `on conflict` re-checks against the latest row version; the plain
      // select beside it keeps the snapshot taken when the statement began. So
      // a claimant that blocks on somebody else's uncommitted insert wakes up
      // to an insert that correctly conflicts and a select that correctly finds
      // nothing — and has to decide what that means.
      const key = nextKey();

      const holder = await schema.db.session();
      const contender = await schema.db.session();

      try {
        await holder.exec('begin');
        const first = postgresRecords(holder);
        await first.claim(key, A);
        await first.complete(key, RESPONSE);

        // Blocks on the holder's speculative insertion.
        const pending = postgresRecords(contender).claim(key, A);
        await wait(200);
        await holder.exec('commit');

        // The answer is the true one, not a defensive 409: the second read
        // runs on a fresh snapshot and finds the response that was committed
        // while this claim was waiting.
        expect(await pending).toEqual({
          outcome: 'replay',
          response: RESPONSE,
        });
      } finally {
        holder.release(true);
        contender.release(true);
      }
    });

    it('keeps the two clocks in different columns', async () => {
      // Not a behavioural assertion — a structural one. A future
      // simplification that folds these into one column passes several
      // behaviour tests before it fails the interesting ones, and this fails
      // immediately.
      const records = postgresRecords(schema.db, {
        leaseFor: millis(500),
        ttl: millis(60_000),
      });
      const key = nextKey();

      await records.claim(key, A);
      const inFlight = await schema.db.queryRow<{
        lease_until: Date | null;
        expires_at: Date | null;
      }>(
        `select lease_until, expires_at from ${RECORDS_TABLE}
          where tenant = $1 and principal = $2 and key = $3`,
        [key.tenant, key.principal, key.key],
      );

      expect(inFlight?.lease_until).not.toBeNull();
      expect(inFlight?.expires_at).toBeNull();

      await records.complete(key, RESPONSE);
      const completed = await schema.db.queryRow<{
        lease_until: Date | null;
        expires_at: Date | null;
      }>(
        `select lease_until, expires_at from ${RECORDS_TABLE}
          where tenant = $1 and principal = $2 and key = $3`,
        [key.tenant, key.principal, key.key],
      );

      // The lease is over the moment the handler finished; the replay window
      // has an hour to run. Exactly one clock applies in each state.
      expect(completed?.lease_until).toBeNull();
      expect(completed?.expires_at).not.toBeNull();
    });

    it('stores the scope in the primary key, not the client`s key alone', async () => {
      // A `primary key (key)` looks like a simplification in review and is the
      // cross-tenant read. This asserts the shape rather than trusting it.
      const columns = await schema.db.query<{ attname: string }>(
        `select a.attname
           from pg_index i
           join pg_attribute a
             on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
          where i.indrelid = $1::regclass and i.indisprimary
          order by a.attnum`,
        [RECORDS_TABLE],
      );

      expect(columns.map((c) => c.attname)).toEqual([
        'tenant',
        'principal',
        'key',
      ]);
    });

    it('purges expired records without touching in-flight ones', async () => {
      const short = postgresRecords(schema.db, { ttl: millis(300) });
      const long = postgresRecords(schema.db, { ttl: millis(60_000) });

      const expired = nextKey();
      const live = nextKey();
      const claimed = nextKey();

      await short.claim(expired, A);
      await short.complete(expired, RESPONSE);
      await long.claim(live, A);
      await long.complete(live, RESPONSE);
      await long.claim(claimed, A);

      await wait(500);
      const dropped = await short.purge();

      expect(dropped).toBeGreaterThanOrEqual(1);
      expect(await short.claim(expired, A)).toEqual({ outcome: 'claimed' });
      expect(await long.claim(live, A)).toEqual({
        outcome: 'replay',
        response: RESPONSE,
      });
      // Still in flight: an expired lease means reclaimable, not garbage.
      expect(await long.claim(claimed, A)).toEqual({ outcome: 'in-flight' });
    });
  });
});
