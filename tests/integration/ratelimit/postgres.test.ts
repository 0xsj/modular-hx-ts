/**
 * The shared bucket store, against a real PostgreSQL. **Rung 2.**
 *
 * The shared contract, plus what only a real database can demonstrate:
 *
 * - **Two limiters are two connections.** In the memory twin they are two
 *   objects over one map, which proves the *shape* of sharing; here they race
 *   for real, which proves the atomicity.
 * - **Check-and-consume under genuine concurrency.** Read-then-write passes
 *   every sequential case and admits more than the limit here.
 *
 * The waits are real. `now()` lives inside PostgreSQL, where no injected clock
 * reaches — so the windows are short and the suite waits rather than pretending.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { millis, type Millis } from '../../../src/shared/clock/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import {
  type Limit,
  BUCKETS_TABLE,
  postgresBuckets,
  ratelimitMigrations,
} from '../../../src/shared/ratelimit/index.js';
import { bucketContract } from '../../../src/shared/ratelimit/ratelimittest.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;

let counter = 0;
const nextKey = (): string => `pg-${String(++counter)}`;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

integration('postgres rate limit buckets', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, ratelimitMigrations);
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    bucketContract(() => ({
      name: 'postgres',
      buckets: () => postgresBuckets(schema.db),
      // **Short, because the waits are real.** `now()` lives inside PostgreSQL
      // and no injected clock reaches it, so the only honest way to let this
      // adapter's time pass is to let time pass. Two seconds is wide enough
      // that a millisecond of query latency is noise against a 400ms token,
      // and narrow enough that the whole suite runs in seconds.
      window: millis(2_000),
      advance: (duration: Millis) => wait(duration),
    }));
  });

  describe('what only a real database proves', () => {
    it('admits exactly the limit when the whole burst races', async () => {
      // **The defect this port exists to prevent.** The pool hands each of
      // these its own connection, so they genuinely race — which is what the
      // in-process suite cannot demonstrate however many promises it starts.
      const buckets = postgresBuckets(schema.db);
      const limit: Limit = { limit: 5, window: millis(60_000) };
      const key = nextKey();

      const outcomes = await Promise.all(
        Array.from({ length: 40 }, () => buckets.take(key, limit)),
      );

      expect(outcomes.filter((o) => o.allowed)).toHaveLength(5);
    });

    it('admits exactly the limit across four independent limiters', async () => {
      // Four limiters are four replicas. A per-process bucket admits twenty
      // here and reports five, and every single-instance test passes.
      const replicas = Array.from({ length: 4 }, () =>
        postgresBuckets(schema.db),
      );
      const limit: Limit = { limit: 5, window: millis(60_000) };
      const key = nextKey();

      const outcomes = await Promise.all(
        replicas.flatMap((replica) =>
          Array.from({ length: 5 }, () => replica.take(key, limit)),
        ),
      );

      expect(outcomes.filter((o) => o.allowed)).toHaveLength(5);
    });

    it('refills on the database`s clock, not on any process`s', async () => {
      const buckets = postgresBuckets(schema.db);
      const limit: Limit = { limit: 4, window: millis(400) };
      const key = nextKey();

      for (let i = 0; i < 4; i++) await buckets.take(key, limit);
      expect((await buckets.take(key, limit)).allowed).toBe(false);

      await wait(300);

      // Two windows' worth of tokens have not accrued; some have.
      expect((await buckets.take(key, limit)).allowed).toBe(true);
    });

    it('stores fractional tokens, or a busy caller never refills', async () => {
      // **Rounding to whole tokens on every write is the subtle version of
      // "the limiter is broken".** Each write floors away the fraction that
      // had just accrued, so a steady stream of requests keeps a bucket at
      // zero forever — and it looks like the limit working.
      const buckets = postgresBuckets(schema.db);
      const limit: Limit = { limit: 10, window: millis(1_000) };
      const key = nextKey();

      // Six first, so the bucket is nowhere near its cap: refilling into a
      // full bucket clamps to a whole number and would prove nothing.
      for (let i = 0; i < 6; i++) await buckets.take(key, limit);
      await wait(50);
      await buckets.take(key, limit);

      const row = await schema.db.queryRow<{ tokens: number }>(
        `select tokens from ${BUCKETS_TABLE} where key = $1`,
        [key],
      );

      const tokens = row?.tokens ?? 0;
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).not.toBe(Math.floor(tokens));
    });

    it('keeps one row per caller, and only one', async () => {
      const buckets = postgresBuckets(schema.db);
      const limit: Limit = { limit: 3, window: millis(60_000) };
      const key = nextKey();

      await Promise.all(
        Array.from({ length: 10 }, () => buckets.take(key, limit)),
      );

      const rows = await schema.db.query<{ n: string }>(
        `select count(*) as n from ${BUCKETS_TABLE} where key = $1`,
        [key],
      );

      expect(rows[0]?.n).toBe('1');
    });

    it('purges idle buckets and leaves busy ones', async () => {
      const buckets = postgresBuckets(schema.db);
      const limit: Limit = { limit: 5, window: millis(300) };
      const idle = nextKey();
      const busy = nextKey();

      await buckets.take(idle, limit);
      await wait(400);
      await buckets.take(busy, limit);

      await buckets.purge(limit);

      const remaining = await schema.db.query<{ key: string }>(
        `select key from ${BUCKETS_TABLE} where key = any($1::text[])`,
        [[idle, busy]],
      );

      expect(remaining.map((r) => r.key)).toEqual([busy]);
    });
  });
});
