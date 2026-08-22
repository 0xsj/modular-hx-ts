/**
 * The transactional outbox. **A provider, and the durable one.**
 *
 * The event row is written **inside the caller's transaction**, so publishing
 * is atomic with the data write — there is no window in which the row exists
 * and the event does not, or the reverse. A relay dispatches afterwards.
 *
 * That is the entire reason it exists, and it is something the memory bus
 * structurally cannot provide. Both satisfy the same port; they do **not** make
 * the same promise, and `eventstest` asserts only what they share.
 *
 * See `notes/patterns/events.md`.
 */

import { type Clock, type Millis, millis, seconds } from '../../clock/index.js';
import { type IdGenerator } from '../../id/index.js';
import { type DB } from '../../postgres/index.js';
import { type Provenance } from '../../provenance/index.js';
import { type Random } from '../../random/index.js';
import { Envelope, type EnvelopeWire } from '../envelope.js';
import { type Event } from '../event.js';
import {
  matches,
  type Dispatcher,
  type Events,
  type Subscription,
} from '../ports.js';
import { DEAD_LETTER_TABLE, HANDLED_TABLE, OUTBOX_TABLE } from './schema.js';

export interface OutboxOptions {
  /** The pool. Used by the **relay**; publishing uses the caller's `db`. */
  readonly db: DB;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  /** How many envelopes one relay pass claims. */
  readonly batchSize?: number;
  /** How long a claim is held before another relay may take the row. */
  readonly leaseFor?: Millis;
  /** Attempts before a row is dead-lettered rather than retried forever. */
  readonly maxAttempts?: number;
  /** Names this relay in `lease_owner`, so a stuck claim is attributable. */
  readonly owner?: string;
}

export interface Outbox extends Events {
  /** Rows that exhausted their attempts. Never dropped. */
  deadLetters(): Promise<
    readonly { id: string; name: string; error: string }[]
  >;
  pending(): Promise<number>;
}

export function outboxEvents(options: OutboxOptions): Outbox {
  const { db, clock, ids, random } = options;
  const batchSize = options.batchSize ?? 32;
  const leaseFor = options.leaseFor ?? seconds(30);
  const maxAttempts = options.maxAttempts ?? 8;
  const owner = options.owner ?? `relay-${String(process.pid)}`;

  const subscriptions: Subscription[] = [];

  /**
   * Full jitter, as `retry` uses.
   *
   * A relay is the worst place for synchronised retries: every instance backs
   * off the same failing subscriber at the same moment and they all return
   * together.
   */
  const backoff = (attempts: number): Millis => {
    const ceiling = Math.min(seconds(300), seconds(1) * 2 ** attempts);
    // `int` is uniform over [0, n) — full jitter picks anywhere in the window,
    // which is what stops N relays returning together.
    return millis(random.int(Math.max(1, Math.floor(ceiling))));
  };

  const dispatcher: Dispatcher = {
    async drain(): Promise<number> {
      // Claim and dispatch are separate transactions on purpose: holding a
      // transaction open across a subscriber's work would put an arbitrary
      // handler inside the database's idle-in-transaction budget.
      const claimed = await claim();
      let dispatched = 0;

      for (const row of claimed) {
        const envelope = Envelope.fromWire(row.envelope, () => ids.uuid());
        if (!envelope.ok) {
          // Unreadable bytes will not become readable on a retry.
          await bury(row, 'envelope could not be read');
          continue;
        }

        const failure = await deliver(envelope.value);
        if (failure === undefined) {
          await db.exec(`delete from ${OUTBOX_TABLE} where id = $1`, [row.id]);
          dispatched += 1;
          continue;
        }

        const attempts = row.attempts + 1;
        if (attempts >= maxAttempts) {
          // **Dead-letter rather than drop.** An event nobody can handle is
          // still evidence that it happened, and deleting it destroys the only
          // record of a failure somebody has to investigate.
          await bury(row, failure);
          continue;
        }

        await db.exec(
          `update ${OUTBOX_TABLE}
              set attempts = $2,
                  next_attempt_at = now() + ($3 || ' milliseconds')::interval,
                  lease_until = null,
                  lease_owner = null
            where id = $1`,
          [row.id, attempts, String(backoff(attempts))],
        );
      }

      return dispatched;
    },
  };

  interface Row {
    readonly id: string;
    readonly attempts: number;
    readonly name: string;
    readonly envelope: EnvelopeWire;
  }

  /**
   * Claim a batch.
   *
   * `for update skip locked` is what lets N relays run without coordinating:
   * each takes rows the others have not, and none of them waits.
   */
  async function claim(): Promise<readonly Row[]> {
    return db.query<Row>(
      `update ${OUTBOX_TABLE} o
          set lease_until = now() + ($2 || ' milliseconds')::interval,
              lease_owner = $3
        where o.id in (
          select id from ${OUTBOX_TABLE}
           where next_attempt_at <= now()
             and (lease_until is null or lease_until < now())
           order by occurred_at
           limit $1
           for update skip locked
        )
      returning o.id, o.attempts, o.name, o.envelope`,
      [batchSize, String(leaseFor), owner],
    );
  }

  /** Deliver to every matching subscriber. Returns the first failure, if any. */
  async function deliver(envelope: Envelope): Promise<string | undefined> {
    let failure: string | undefined;

    for (const subscription of subscriptions) {
      if (!matches(subscription.pattern, envelope.name)) continue;

      // At-least-once means this envelope may already have been handled by
      // this subscriber and the delete lost afterwards. The dedupe record is
      // per (subscriber, event), so one subscriber succeeding does not rob
      // another of its delivery.
      const handled = await db.queryRow(
        `select 1 from ${HANDLED_TABLE} where subscriber = $1 and event_id = $2`,
        [subscription.name, envelope.id],
      );
      if (handled !== undefined) continue;

      try {
        await subscription.handle(envelope);
        await db.exec(
          `insert into ${HANDLED_TABLE} (subscriber, event_id) values ($1, $2)
             on conflict do nothing`,
          [subscription.name, envelope.id],
        );
      } catch (error) {
        // One subscriber failing does not stop the others, and does not undo
        // the ones that already ran — their dedupe rows mean the retry skips
        // them.
        failure ??= `${subscription.name}: ${String(error)}`;
      }
    }

    return failure;
  }

  async function bury(
    row: { id: string; name: string; attempts: number; envelope: EnvelopeWire },
    error: string,
  ): Promise<void> {
    await db.exec(
      `insert into ${DEAD_LETTER_TABLE} (id, name, envelope, attempts, last_error)
         values ($1, $2, $3, $4, $5) on conflict (id) do nothing`,
      [row.id, row.name, JSON.stringify(row.envelope), row.attempts, error],
    );
    await db.exec(`delete from ${OUTBOX_TABLE} where id = $1`, [row.id]);
  }

  return {
    async publish(event: Event, provenance: Provenance, writer?: DB) {
      // **The caller's transaction, or nothing atomic.** Defaulting to the pool
      // would silently turn every publish into a second transaction and give
      // back exactly the dual-write problem this provider removes.
      const target = writer ?? db;
      const envelope = Envelope.seal(
        event,
        provenance,
        ids.uuid(),
        clock.now(),
      );

      await target.exec(
        `insert into ${OUTBOX_TABLE} (id, name, occurred_at, envelope)
           values ($1, $2, $3, $4)`,
        [
          envelope.id,
          envelope.name,
          envelope.occurredAt.toISOString(),
          JSON.stringify(envelope.toJSON()),
        ],
      );

      return envelope;
    },

    subscribe(subscription) {
      subscriptions.push(subscription);
    },

    dispatcher,

    async deadLetters() {
      return db.query(
        `select id, name, last_error as error from ${DEAD_LETTER_TABLE} order by dead_at`,
      );
    },

    async pending() {
      const row = await db.queryRow<{ n: string }>(
        `select count(*)::text as n from ${OUTBOX_TABLE}`,
      );
      return Number(row?.n ?? 0);
    },
  };
}

/** Re-exported so a caller does not reach into `outbox/schema.js`. */
export { outboxMigrations, OUTBOX_TABLE } from './schema.js';
