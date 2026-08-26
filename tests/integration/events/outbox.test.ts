/**
 * The outbox provider, against a real PostgreSQL. **Rung 2.**
 *
 * Runs the same `eventstest` contract the memory bus runs, plus the properties
 * only this provider has: atomicity with the caller's transaction, leasing,
 * backoff, and dead-lettering.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/shared/clock/index.js';
import {
  event,
  outboxEvents,
  outboxMigrations,
  type Outbox,
} from '../../../src/shared/events/index.js';
import { eventsContract } from '../../../src/shared/events/eventstest.js';
import { systemIds } from '../../../src/shared/id/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { fakeProvenance } from '../../../src/shared/provenance/provenance.testkit.js';
import { systemRandom } from '../../../src/shared/random/index.js';
import { unwrap } from '../../../src/shared/result/index.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

const clock = systemClock();
const random = systemRandom();
const ids = systemIds(clock, (n) => random.bytes(n));

let schema: Schema;
let events: Outbox;

const registered = unwrap(event('identity.user.registered', { user_id: 'u1' }));

integration('outbox', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, outboxMigrations);
  });

  afterEach(async () => {
    for (const table of [
      'event_outbox',
      'event_dead_letters',
      'event_handled',
    ]) {
      await schema.db.exec(`truncate ${table}`);
    }
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    eventsContract(() => {
      events = outboxEvents({ db: schema.db, clock, ids, random });
      return {
        events,
        name: 'outbox',
        provenance: () => fakeProvenance(),
        // Publishing only writes a row; the relay is what delivers.
        settle: async () => {
          await events.dispatcher.drain();
        },
        // A genuine second dispatch, covering **both** ways one really happens:
        //
        //   - the row was delivered and deleted, and the delete was lost — so
        //     it is re-inserted;
        //   - the row is still present in backoff after a subscriber failed —
        //     so it is made eligible, which is exactly what the relay does when
        //     the backoff elapses.
        //
        // The first version did only the insert, and `on conflict do nothing`
        // then silently no-opped against a row still sitting in backoff, so
        // nothing was redelivered at all. The suite caught it the moment
        // `dedupe does not suppress a retry` ran.
        redeliver: async (envelope) => {
          await schema.db.exec(
            `insert into event_outbox (id, name, occurred_at, envelope)
               values ($1, $2, $3, $4) on conflict (id) do nothing`,
            [
              envelope.id,
              envelope.name,
              envelope.occurredAt.toISOString(),
              JSON.stringify(envelope.toJSON()),
            ],
          );
          await schema.db.exec(
            `update event_outbox
                set next_attempt_at = now(), lease_until = null, lease_owner = null
              where id = $1`,
            [envelope.id],
          );
          await events.dispatcher.drain();
        },
      };
    });
  });

  describe('atomicity with the caller’s transaction', () => {
    it('publishes inside the write, so a rollback takes the event with it', async () => {
      // The entire reason this provider exists. If the event row were written
      // on its own connection, the rollback below would leave an event
      // announcing something that never happened.
      const bus = outboxEvents({ db: schema.db, clock, ids, random });
      await schema.db.exec(
        'create table if not exists widgets (id int primary key)',
      );
      await schema.db.exec('truncate widgets');

      await schema.db
        .withinTx(async (tx) => {
          await tx.exec('insert into widgets (id) values (1)');
          await bus.publish(registered, fakeProvenance(), tx);
          throw new Error('deliberate');
        })
        .catch(() => undefined);

      expect(await bus.pending()).toBe(0);
      expect(await schema.db.query('select id from widgets')).toEqual([]);
    });

    it('commits the event with the write, not beside it', async () => {
      const bus = outboxEvents({ db: schema.db, clock, ids, random });
      await schema.db.exec('truncate widgets');

      await schema.db.withinTx(async (tx) => {
        await tx.exec('insert into widgets (id) values (2)');
        await bus.publish(registered, fakeProvenance(), tx);
      });

      expect(await bus.pending()).toBe(1);
      expect(await schema.db.query('select id from widgets')).toHaveLength(1);
    });
  });

  describe('the relay', () => {
    it('delivers once when two relays drain the same event', async () => {
      // **This is not the lease test its name used to claim.** It passed with
      // the lease predicate removed, with `for update skip locked` removed, and
      // with both removed — because the first relay *deletes* the row on
      // success, so the second's re-evaluated claim finds nothing whatever the
      // locking says. It asserts a true and worthwhile outcome for a cause it
      // does not name. The lease is tested below, by holding a delivery open.
      const a = outboxEvents({ db: schema.db, clock, ids, random, owner: 'a' });
      const b = outboxEvents({ db: schema.db, clock, ids, random, owner: 'b' });

      let handled = 0;
      const count = {
        name: 'counter',
        pattern: 'identity.*',
        handle: () => {
          handled += 1;
        },
      };
      a.subscribe(count);
      b.subscribe(count);

      await a.publish(registered, fakeProvenance());

      // Concurrent drains. `for update skip locked` means one takes the row and
      // the other finds nothing rather than waiting.
      const [ra, rb] = await Promise.all([
        a.dispatcher.drain(),
        b.dispatcher.drain(),
      ]);

      expect(ra + rb).toBe(1);
      expect(handled).toBe(1);
    });

    it('LEASES the row, so a relay drains nothing while another holds it', async () => {
      // The mechanism the test above was named for, exercised by holding the
      // first relay inside its handler — which is the only window in which the
      // lease is the thing standing between two relays and a double delivery.
      // Removing `lease_until is null or lease_until < now()` fails this.
      const a = outboxEvents({ db: schema.db, clock, ids, random, owner: 'a' });
      const b = outboxEvents({ db: schema.db, clock, ids, random, owner: 'b' });

      let release: () => void = () => undefined;
      const held = new Promise<void>((resume) => {
        release = resume;
      });

      a.subscribe({
        name: 'slow',
        pattern: 'identity.*',
        handle: () => held,
      });
      // **A different subscriber name on purpose.** Sharing one would let the
      // per-(subscriber, event) dedupe row mask a second claim, which is
      // exactly how the test above ended up proving something else.
      let alsoHandled = 0;
      b.subscribe({
        name: 'other',
        pattern: 'identity.*',
        handle: () => {
          alsoHandled += 1;
        },
      });

      await a.publish(registered, fakeProvenance());

      const first = a.dispatcher.drain();
      // Long enough for A to have claimed and entered its handler.
      await new Promise((resume) => setTimeout(resume, 200));

      const second = await b.dispatcher.drain();

      release();
      await first;

      expect(second).toBe(0);
      expect(alsoHandled).toBe(0);
    });

    it('keeps backoff and ownership in separate columns', async () => {
      // Collapsing them is the bug that makes a slow consumer look like a dead
      // one. After a failure the row must be *unleased* and *not yet eligible*
      // — two different facts.
      const bus = outboxEvents({ db: schema.db, clock, ids, random });
      bus.subscribe({
        name: 'fails',
        pattern: 'identity.*',
        handle: () => {
          throw new Error('deliberate');
        },
      });

      await bus.publish(registered, fakeProvenance());
      await bus.dispatcher.drain();

      const row = await schema.db.queryRow<{
        attempts: number;
        lease_until: Date | null;
        eligible: boolean;
      }>(
        `select attempts, lease_until, next_attempt_at <= now() as eligible
           from event_outbox limit 1`,
      );

      expect(row?.attempts).toBe(1);
      expect(row?.lease_until).toBeNull(); // ownership released
      expect(row?.eligible).toBe(false); // backoff still pending
    });

    it('dead-letters rather than drops', async () => {
      // An event nobody can handle is still evidence that it happened.
      const bus = outboxEvents({
        db: schema.db,
        clock,
        ids,
        random,
        maxAttempts: 1,
      });
      bus.subscribe({
        name: 'fails',
        pattern: 'identity.*',
        handle: () => {
          throw new Error('deliberate');
        },
      });

      await bus.publish(registered, fakeProvenance());
      await bus.dispatcher.drain();

      expect(await bus.pending()).toBe(0);
      const dead = await bus.deadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]?.name).toBe('identity.user.registered');
      expect(dead[0]?.error).toContain('fails');
    });

    it('keys the dedupe row per subscriber, not per event', async () => {
      // The *behaviour* — dedupe holds for the subscriber that succeeded and
      // does not suppress the one that failed — is asserted for both providers
      // by the shared contract. This asserts the thing only the outbox has: the
      // shape of the row that makes it durable.
      //
      // Keyed per subscriber because two subscribers must each get their own
      // delivery; keyed per event because that is what a redelivery collides
      // with. An earlier version of this test asserted only that the succeeded
      // subscriber was not re-run, which a provider that recorded the dedupe
      // unconditionally would also have passed.
      const bus = outboxEvents({ db: schema.db, clock, ids, random });
      bus.subscribe({
        name: 'good',
        pattern: 'identity.*',
        handle: () => undefined,
      });
      bus.subscribe({
        name: 'bad',
        pattern: 'identity.*',
        handle: () => {
          throw new Error('deliberate');
        },
      });

      const envelope = await bus.publish(registered, fakeProvenance());
      await bus.dispatcher.drain();

      const rows = await schema.db.query<{
        subscriber: string;
        event_id: string;
      }>('select subscriber, event_id from event_handled order by subscriber');

      // Exactly one row: the subscriber that failed has not handled it and must
      // not be recorded as having done so.
      expect(rows).toEqual([{ subscriber: 'good', event_id: envelope.id }]);
    });
  });
});
