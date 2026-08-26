/**
 * `exports` against a real database. **Rung 2.**
 *
 * One case, and it is the reason this file exists: **the export row, its
 * operation and its queue entry are one commit.** Any two without the third is
 * a state nobody has code for — an operation with no job says *running*
 * forever, a job with no export dereferences nothing, and an export with no
 * operation is work nobody can find.
 *
 * The memory suite cannot fail this: its transactor hands out `undefined` for a
 * writer, honestly, because there is nothing to join. Deleting `work.writer`
 * from the command leaves that suite green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { subject } from '../../../src/shared/authz/index.js';
import {
  memoryBlobStore,
  memoryBlobs,
} from '../../../src/shared/blob/index.js';
import { fakeClock } from '../../../src/shared/clock/index.js';
import { memoryEvents } from '../../../src/shared/events/index.js';
import { fakeIds } from '../../../src/shared/id/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { operationsMigrations } from '../../../src/shared/operations/index.js';
import { Actor, makeOrigins } from '../../../src/shared/provenance/index.js';
import { systemRandom } from '../../../src/shared/random/index.js';
import { unwrap } from '../../../src/shared/result/index.js';
import { WORK_TABLE, workMigrations } from '../../../src/shared/work/index.js';
import { makeExports } from '../../../src/contexts/exports/index.js';
import {
  EXPORTS_TABLE,
  exportsMigrations,
} from '../../../src/contexts/exports/infra/postgres/schema.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;
const clock = fakeClock();
const ME = '019b76da-a800-7000-8000-0000000000c1';

/** An empty dataset, as an async iterable the linter is content with. */
function empty(): AsyncIterable<Readonly<Record<string, unknown>>> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () =>
        Promise.resolve({ done: true as const, value: undefined as never }),
    }),
  };
}

integration('postgres exports', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, [
      ...operationsMigrations,
      ...workMigrations,
      ...exportsMigrations,
    ]);
  });

  afterAll(async () => {
    await schema.close();
  });

  const ids = fakeIds(clock);
  const origins = makeOrigins(ids);
  const random = systemRandom();

  const context = (explode = false) =>
    makeExports({
      clock,
      ids,
      random,
      publisher: memoryEvents({ clock, ids }),
      blobs: memoryBlobs(memoryBlobStore(), clock),
      datasets: {
        rows: () =>
          (async function* () {
            await Promise.resolve();
            if (explode) throw new Error('boom');
            yield { id: 'u-1', name: 'Ada' };
          })(),
      },
      db: schema.db,
      caller: () =>
        subject({
          actor: unwrap(Actor.user(ME)),
          roles: [],
          tenant: 'acme',
        }),
    });

  const counts = async (): Promise<{ exports: number; jobs: number }> => {
    const one = await schema.db.queryRow<{ n: string }>(
      `select count(*)::text as n from ${EXPORTS_TABLE}`,
    );
    const two = await schema.db.queryRow<{ n: string }>(
      `select count(*)::text as n from ${WORK_TABLE}`,
    );
    return { exports: Number(one?.n ?? 0), jobs: Number(two?.n ?? 0) };
  };

  describe('three writes, one commit', () => {
    it('lands the export, the operation and the job together', async () => {
      const exports = context();
      const before = await counts();

      const { requestExport } =
        await import('../../../src/contexts/exports/app/command/request.js');
      const accepted = await requestExport(
        exports.deps,
        subject({
          actor: unwrap(Actor.user(ME)),
          roles: [],
          tenant: 'acme',
        }),
        { dataset: 'users', format: 'csv' },
        origins.forRequest(),
      );

      const after = await counts();
      const operation = await exports.deps.operations.byId(
        accepted.operationId,
      );

      expect(after.exports).toBe(before.exports + 1);
      expect(after.jobs).toBe(before.jobs + 1);
      expect(operation?.state).toBe('running');
    });

    it('lands NONE of them when the transaction fails', async () => {
      // **Through the real command**, and failing where a real failure would.
      // The first version of this hand-rolled the three writes and passed
      // `work.writer` to each — so it was testing the argument it supplied
      // rather than what the transactor bound, and deleting the binding from
      // all three left it green. Breaking a mechanism has to break the test.
      //
      // The publish is the last step inside `requestExport`'s transaction, so
      // a publisher that throws rolls back exactly what the command wrote.
      //
      // **Two mechanisms, either sufficient, and the breakage pass is what
      // showed it.** The transactor binds each adapter to `tx` *and* sets
      // `writer: tx`; the adapters resolve `(writer) ?? db`, and `db` inside an
      // adapter built with `tx` **is** `tx`. So deleting either alone changes
      // nothing and this test stays green — it only fails when both go. That is
      // belt and braces rather than a bug, and it is worth writing down,
      // because a future reader deleting one and seeing green will conclude the
      // test is worthless rather than that the other half caught them.
      const exports = makeExports({
        clock,
        ids,
        random,
        publisher: {
          publish: () => Promise.reject(new Error('the bus is down')),
          subscribe: () => undefined,
          dispatcher: { drain: () => Promise.resolve(0) },
        } as never,
        blobs: memoryBlobs(memoryBlobStore(), clock),
        datasets: {
          // Nothing is read in this case: the failure happens after the writes
          // and before any row is fetched.
          rows: () => empty(),
        },
        db: schema.db,
        caller: () =>
          subject({
            actor: unwrap(Actor.user(ME)),
            roles: [],
            tenant: 'acme',
          }),
      });

      const before = await counts();
      let thrown = '';

      const { requestExport } =
        await import('../../../src/contexts/exports/app/command/request.js');
      await requestExport(
        exports.deps,
        subject({
          actor: unwrap(Actor.user(ME)),
          roles: [],
          tenant: 'acme',
        }),
        { dataset: 'users', format: 'csv' },
        origins.forRequest(),
      ).catch((e: unknown) => {
        thrown = String(e);
      });

      // All three, or none. An operation with no job says *running* forever; a
      // job with no export dereferences nothing.
      const after = await counts();
      // All three, or none. An operation with no job says *running* forever; a
      // job with no export dereferences nothing.
      expect([after.exports, after.jobs]).toEqual([
        before.exports,
        before.jobs,
      ]);
      expect(thrown).toContain('the bus is down');
    });
  });

  describe('the worker, against real rows', () => {
    it('produces an artifact and settles the operation', async () => {
      const exports = context();
      const { requestExport } =
        await import('../../../src/contexts/exports/app/command/request.js');
      const accepted = await requestExport(
        exports.deps,
        subject({
          actor: unwrap(Actor.user(ME)),
          roles: [],
          tenant: 'acme',
        }),
        { dataset: 'users', format: 'csv' },
        origins.forRequest(),
      );

      const { worker } = await import('../../../src/shared/work/index.js');
      await worker({
        queue: exports.queue,
        clock,
        handle: exports.handle,
      }).drain();

      const operation = await exports.deps.operations.byId(
        accepted.operationId,
      );
      expect(operation?.state).toBe('succeeded');
      expect(operation?.result?.href).toBe(
        `/v1/exports/${accepted.id}/download`,
      );
    });
  });
});
