/**
 * The durable queue against a real database. **Rung 2.**
 *
 * The shared contract, plus the one case only a database can fail: **enqueue in
 * your transaction**. The memory twin supplies no `rollBack`, honestly, because
 * it has nothing to make atomic — so that case runs here and nowhere else, and
 * it is the case the collection has now watched two blueprints ship without.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock, seconds } from '../../../src/shared/clock/index.js';
import { fakeIds } from '../../../src/shared/id/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { makeOrigins } from '../../../src/shared/provenance/index.js';
import { systemRandom } from '../../../src/shared/random/index.js';
import { queueContract } from '../../../src/shared/work/worktest.js';
import { postgresQueue } from '../../../src/shared/work/postgres.js';
import { WORK_TABLE, workMigrations } from '../../../src/shared/work/schema.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;
const clock = fakeClock();
const ids = fakeIds(clock);
const origins = makeOrigins(ids);
const random = systemRandom();
const MAX_ATTEMPTS = 3;

integration('postgres queue', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, workMigrations);
  });

  afterAll(async () => {
    await schema.close();
  });

  const queue = () =>
    postgresQueue({
      db: schema.db,
      ids,
      random,
      maxAttempts: MAX_ATTEMPTS,
    });

  queueContract(() => ({
    name: 'postgres',
    queue,
    provenance: () => origins.forRequest(),
    maxAttempts: MAX_ATTEMPTS,
    // **The half only this adapter has.** A transaction the caller controls,
    // rolled back, so the contract can ask whether the enqueue joined it.
    rollBack: async (work) => {
      await schema.db
        .withinTx(async (tx) => {
          await work(tx);
          throw new Error('rolling back on purpose');
        })
        .catch(() => undefined);
    },
  }));

  describe('what only a real transaction proves', () => {
    it('commits the job with the write, not beside it', async () => {
      // The other direction of the same property: the row the job is about and
      // the queue entry land together. Neither existing is recoverable; one
      // existing without the other is the state nobody has code for.
      const q = queue();
      const before = await q.pending();

      await schema.db.withinTx(async (tx) => {
        await tx.exec(
          `create table if not exists work_probe (id uuid primary key)`,
        );
        await tx.exec(`insert into work_probe (id) values ($1)`, [ids.uuid()]);
        await q.enqueue(
          'probe',
          { ok: true },
          origins.forRequest(),
          clock.now(),
          tx,
        );
      });

      expect(await q.pending()).toBe(before + 1);
    });

    it('leaves NOTHING behind when the write fails after the enqueue', async () => {
      // The ordering that catches a queue writing on its own connection: the
      // enqueue succeeds, the data write then fails, and a queue outside the
      // transaction keeps a job for a row that never existed.
      const q = queue();
      const before = await q.pending();

      await schema.db
        .withinTx(async (tx) => {
          await q.enqueue('doomed', {}, origins.forRequest(), clock.now(), tx);
          await tx.exec(`select 1 / 0`);
        })
        .catch(() => undefined);

      expect(await q.pending()).toBe(before);
    });

    it('hands one job to exactly one of two concurrent workers', async () => {
      // Two connections, genuinely racing. `for update skip locked` is the
      // latency property and the **lease predicate** is the correctness one —
      // stated that way because crediting the wrong one is how a break stops
      // being detectable.
      const q = queue();
      await q.enqueue('solo', {}, origins.forRequest(), clock.now());

      const [a, b] = await Promise.all([
        q.claim(10, seconds(30), clock.now()),
        q.claim(10, seconds(30), clock.now()),
      ]);

      const both = [...a, ...b].filter((job) => job.kind === 'solo');
      expect(both).toHaveLength(1);
    });

    it('survives a payload that is not a flat object', async () => {
      // `jsonb` round trips, and a payload is the owning context's business —
      // a queue that flattened one would be a queue with an opinion about a
      // domain it has never heard of.
      const q = queue();
      const payload = { nested: { rows: [1, 2, 3] }, when: '2026-03-01' };

      const { id } = await q.enqueue(
        'shaped',
        payload,
        origins.forRequest(),
        clock.now(),
      );
      const claimed = await q.claim(50, seconds(30), clock.now());

      expect(claimed.find((job) => job.id === id)?.payload).toEqual(payload);
    });

    it('keeps the enqueuing provenance across the boundary', async () => {
      const q = queue();
      const origin = origins.forRequest();

      const { id } = await q.enqueue('traced', {}, origin, clock.now());
      const claimed = await q.claim(50, seconds(30), clock.now());

      expect(
        claimed.find((job) => job.id === id)?.provenance.correlationId,
      ).toBe(origin.correlationId);
    });

    it('writes a dead letter rather than losing the row', async () => {
      const q = queue();
      const { id } = await q.enqueue(
        'doomed',
        {},
        origins.forRequest(),
        clock.now(),
      );

      for (let i = 0; i <= MAX_ATTEMPTS; i++) {
        await q.claim(50, seconds(30), clock.now());
        await q.fail(id, 'always fails', clock.now());
        await clock.advance(seconds(600));
      }

      const dead = await q.deadLetters();
      expect(dead.map((one) => one.id)).toContain(id);
      const rows = await schema.db.query<{ n: string }>(
        `select count(*)::text as n from ${WORK_TABLE} where id = $1`,
        [id],
      );
      expect(rows[0]?.n).toBe('0');
    });
  });
});
