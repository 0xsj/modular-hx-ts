/**
 * `webhooks` against a real PostgreSQL. **Rung 2.**
 *
 * Two properties only a database can show, and both are about the fan-out:
 *
 * - **N delivery rows and N jobs commit together, or none do.** The memory
 *   transactor snapshots a `Map`, which is enough to prove the *shape* and
 *   nothing about durability.
 * - **The same envelope twice produces one delivery**, and the unique index is
 *   what enforces it under concurrency. The memory twin checks the same rule
 *   with a scan, which cannot lose a race because there is no race to lose.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '../../../src/shared/clock/index.js';
import { memoryEvents } from '../../../src/shared/events/index.js';
import { fakeIds } from '../../../src/shared/id/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { makeOrigins } from '../../../src/shared/provenance/index.js';
import { fakeRandom } from '../../../src/shared/random/index.js';
import { workMigrations } from '../../../src/shared/work/schema.js';
import {
  Delivery,
  Endpoint,
  deliveryId,
  endpointId,
} from '../../../src/contexts/webhooks/domain/index.js';
import {
  postgresDeliveries,
  postgresEndpoints,
  postgresTransactor,
} from '../../../src/contexts/webhooks/infra/postgres/index.js';
import { webhooksMigrations } from '../../../src/contexts/webhooks/infra/postgres/schema.js';
import { integration } from '../../testx/gate.js';
import { type Schema, withSchema } from '../../testx/postgres.js';

let schema: Schema;
let counter = 0;
const uuid = (): string =>
  `01a03c00-dddd-7000-8000-${String(++counter).padStart(12, '0')}`;

const clock = fakeClock();

integration('postgres webhooks', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, [...webhooksMigrations, ...workMigrations]);
  });

  afterAll(async () => {
    await schema.close();
  });

  const anEndpoint = async (
    events: readonly string[] = ['identity.user.registered'],
  ): Promise<Endpoint> => {
    const endpoint = Endpoint.register(
      endpointId(uuid()),
      uuid(),
      'https://receiver.test/hooks',
      events,
      `sha256:${uuid()}`,
      clock.now(),
    );
    await postgresEndpoints(schema.db).create(endpoint);
    return endpoint;
  };

  const transactor = () =>
    postgresTransactor({
      db: schema.db,
      publisher: memoryEvents({ clock, ids: fakeIds(clock) }),
      ids: { uuid },
      random: fakeRandom(3),
    });

  describe('what only a real database proves', () => {
    it('is atomic through the WRITER ALONE, not only through the binding', async () => {
      // **The discriminating version, and the one that was missing.** The case
      // below binds its adapters to `tx` *and* passes `work.writer`; either
      // alone makes it atomic, so deleting the writer parameter from the
      // adapter changes nothing and the test still passes. `exports` shipped
      // exactly that and it was recorded as belt-and-braces rather than fixed.
      //
      // Here the adapter is bound to the **root pool** and the writer is the
      // only thing carrying the transaction. Ignore the parameter and this
      // fails.
      const endpoint = await anEndpoint();
      const rootDeliveries = postgresDeliveries(schema.db);

      await expect(
        transactor().within(async (work) => {
          await rootDeliveries.create(
            Delivery.queue(
              deliveryId(uuid()),
              endpoint.id,
              { id: uuid(), name: 'identity.user.registered' },
              '{}',
              clock.now(),
            ),
            work.writer,
          );
          throw new Error('rolled back');
        }),
      ).rejects.toThrow();

      const page = await rootDeliveries.list({
        endpointId: endpoint.id,
        limit: 10,
      });

      expect(page.items).toEqual([]);
    });

    it('lands the delivery and its job in ONE commit, or neither', async () => {
      // The clause the whole design rests on: a delivery row with no job never
      // fires, and a job with no row fails forever on a lookup.
      const endpoint = await anEndpoint();
      const before = await countJobs();

      await expect(
        transactor().within(async (work) => {
          await work.deliveries.create(
            Delivery.queue(
              deliveryId(uuid()),
              endpoint.id,
              { id: uuid(), name: 'identity.user.registered' },
              '{}',
              clock.now(),
            ),
            work.writer,
          );
          await work.queue.enqueue(
            'webhooks.deliver',
            { deliveryId: 'x' },
            makeOrigins(fakeIds(clock)).forBoot(),
            clock.now(),
            work.writer,
          );
          throw new Error('the publisher exploded');
        }),
      ).rejects.toThrow();

      const page = await postgresDeliveries(schema.db).list({
        endpointId: endpoint.id,
        limit: 10,
      });

      expect(page.items).toEqual([]);
      expect(await countJobs()).toBe(before);
    });

    it('commits both when nothing throws', async () => {
      // The other half. An enqueue that never lands is not safer than one that
      // lands twice — it is a request that silently did nothing.
      const endpoint = await anEndpoint();
      const before = await countJobs();

      await transactor().within(async (work) => {
        await work.deliveries.create(
          Delivery.queue(
            deliveryId(uuid()),
            endpoint.id,
            { id: uuid(), name: 'identity.user.registered' },
            '{}',
            clock.now(),
          ),
          work.writer,
        );
        await work.queue.enqueue(
          'webhooks.deliver',
          { deliveryId: 'x' },
          makeOrigins(fakeIds(clock)).forBoot(),
          clock.now(),
          work.writer,
        );
      });

      const page = await postgresDeliveries(schema.db).list({
        endpointId: endpoint.id,
        limit: 10,
      });

      expect(page.items).toHaveLength(1);
      expect(await countJobs()).toBe(before + 1);
    });

    it('refuses a SECOND delivery of the same event to the same endpoint', async () => {
      // The bus is at-least-once, so the same envelope arrives twice. Without
      // the unique index the receiver gets the webhook twice under two
      // different delivery ids and has no way to tell they are one event.
      const endpoint = await anEndpoint();
      const deliveries = postgresDeliveries(schema.db);
      const eventId = uuid();

      const queue = () =>
        deliveries.create(
          Delivery.queue(
            deliveryId(uuid()),
            endpoint.id,
            { id: eventId, name: 'identity.user.registered' },
            '{}',
            clock.now(),
          ),
        );

      const outcomes = await Promise.allSettled([queue(), queue()]);

      expect(outcomes.filter((one) => one.status === 'fulfilled')).toHaveLength(
        1,
      );
    });

    it('answers the fan-out with the index, matching exact, prefix and star', async () => {
      // The match is in SQL here and in the aggregate in memory, so this is the
      // case that proves the two agree — the reason `wanting` is a port method
      // rather than a filter the caller applies.
      const exact = await anEndpoint(['identity.user.registered']);
      const prefix = await anEndpoint(['identity.user.*']);
      const star = await anEndpoint(['*']);
      const other = await anEndpoint(['orgs.member.joined']);

      const wanting = await postgresEndpoints(schema.db).wanting(
        'identity.user.registered',
      );
      const ids = wanting.map((one) => one.id);

      expect(ids).toContain(exact.id);
      expect(ids).toContain(prefix.id);
      expect(ids).toContain(star.id);
      expect(ids).not.toContain(other.id);
    });

    it('never fans out to a DISABLED endpoint', async () => {
      // The index carries the predicate, so this is a property of the plan
      // rather than of a filter somebody could forget to apply.
      const endpoint = await anEndpoint(['*']);
      endpoint.disable('owner', clock.now());
      await postgresEndpoints(schema.db).save(endpoint);

      const wanting = await postgresEndpoints(schema.db).wanting('anything.at');

      expect(wanting.map((one) => one.id)).not.toContain(endpoint.id);
    });

    it('takes the deliveries with the endpoint', async () => {
      const endpoint = await anEndpoint();
      await postgresDeliveries(schema.db).create(
        Delivery.queue(
          deliveryId(uuid()),
          endpoint.id,
          { id: uuid(), name: 'identity.user.registered' },
          '{}',
          clock.now(),
        ),
      );

      await postgresEndpoints(schema.db).remove(endpoint.id);

      const rows = await schema.db.query<{ n: string }>(
        'select count(*) as n from webhooks_deliveries where endpoint_id = $1',
        [endpoint.id],
      );
      expect(Number(rows[0]?.n)).toBe(0);
    });

    it('loses a save on a stale version', async () => {
      const endpoint = await anEndpoint();
      const endpoints = postgresEndpoints(schema.db);

      const first = await endpoints.byId(endpoint.id);
      const second = await endpoints.byId(endpoint.id);
      if (first === undefined || second === undefined) throw new Error('gone');

      first.redirect('https://elsewhere.test/hooks', clock.now());
      await endpoints.save(first);

      second.redirect('https://third.test/hooks', clock.now());

      await expect(endpoints.save(second)).rejects.toThrow();
    });
  });

  async function countJobs(): Promise<number> {
    const rows = await schema.db.query<{ n: string }>(
      'select count(*) as n from work_jobs',
    );
    return Number(rows[0]?.n ?? 0);
  }
});
