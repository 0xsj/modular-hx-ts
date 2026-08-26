/**
 * The durable queue. **`work` infra.**
 *
 * **`enqueue` writes through the caller's handle**, which is the whole port:
 * the row the job is about and the queue entry that will process it commit
 * together or neither does.
 *
 * nolint:tenant — a queue entry has no tenant of its own. What it carries is a
 * payload whose *contents* are the owning context's business, and the claim is
 * fleet-wide by construction: a worker takes whatever is due, and scoping the
 * claim by tenant would make one tenant's backlog invisible to a worker that
 * could clear it.
 */

import { type Millis, millis } from '../clock/index.js';
import { type DB, type Postgres, asAppError } from '../postgres/index.js';
import { Provenance as Prov } from '../provenance/index.js';
import { type Random } from '../random/index.js';
import { type Enqueued, type Job, type Queue } from './port.js';
import { WORK_DEAD_TABLE, WORK_TABLE } from './schema.js';

export interface PostgresOptions {
  readonly db: Postgres;
  readonly ids: { uuid(): string };
  readonly random: Random;
  readonly maxAttempts?: number;
  /** Names this worker in `lease_owner`, so a stuck claim is attributable. */
  readonly owner?: string;
}

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly provenance: unknown;
  readonly attempts: number;
}

export function postgresQueue(options: PostgresOptions): Queue {
  const { db, ids, random } = options;
  const maxAttempts = options.maxAttempts ?? 5;
  const owner = options.owner ?? `worker-${String(process.pid)}`;

  /**
   * Full jitter, as `retry` uses.
   *
   * A queue is the worst place for synchronised retries: every worker backs off
   * the same failing job at the same moment and they all return together.
   */
  const backoff = (attempts: number): Millis => {
    const ceiling = Math.min(300_000, 1_000 * 2 ** attempts);
    return millis(random.int(Math.max(1, Math.floor(ceiling))));
  };

  return {
    async enqueue(kind, payload, provenance, at, writer?: unknown) {
      // **The caller's transaction, or nothing atomic.** Defaulting to the pool
      // would silently turn every enqueue into a second transaction and give
      // back the dual-write problem this port removes.
      const target = (writer as DB | undefined) ?? db;
      const id = ids.uuid();

      try {
        await target.exec(
          `insert into ${WORK_TABLE}
             (id, kind, payload, provenance, attempts, next_attempt_at, enqueued_at)
           values ($1, $2, $3, $4, 0, $5, $5)`,
          [
            id,
            kind,
            JSON.stringify(payload),
            JSON.stringify(provenance.toJSON()),
            at,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'enqueue work');
      }

      return { id, kind } satisfies Enqueued;
    },

    async claim(limit, leaseFor, at) {
      const rows = await db
        .query<Row>(
          // `for update skip locked` is the latency property; the **lease
          // predicate** is the correctness one. Both are here, and which does
          // what is stated because a comment that credits the wrong one is how
          // a break stops being detectable — see `events`' outbox, where
          // exactly that was found.
          `update ${WORK_TABLE} w
              set lease_until = $4::timestamptz + ($2 || ' milliseconds')::interval,
                  lease_owner = $3,
                  attempts    = w.attempts + 1
            where w.id in (
              select id from ${WORK_TABLE}
               where next_attempt_at <= $4::timestamptz
                 and (lease_until is null or lease_until < $4::timestamptz)
               order by next_attempt_at
               limit $1
               for update skip locked
            )
          returning w.id, w.kind, w.payload, w.provenance, w.attempts`,
          [limit, String(leaseFor), owner, at],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'claim work');
        });

      return rows.flatMap((row): readonly Job[] => {
        const provenance = Prov.fromWire(() => ids.uuid(), row.provenance);
        if (!provenance.ok) {
          // Unreadable provenance will not become readable on a retry, and a
          // job with none would write records nobody can correlate.
          return [];
        }
        return [
          {
            id: row.id,
            kind: row.kind,
            payload: row.payload,
            attempts: row.attempts,
            provenance: provenance.value,
          },
        ];
      });
    },

    async complete(id) {
      await db.exec(`delete from ${WORK_TABLE} where id = $1`, [id]);
    },

    async fail(id, error, at) {
      const row = await db.queryRow<Row & { payload: unknown }>(
        `select id, kind, payload, provenance, attempts
           from ${WORK_TABLE} where id = $1`,
        [id],
      );
      if (row === undefined) return;

      if (row.attempts >= maxAttempts) {
        await db.withinTx(async (tx) => {
          await tx.exec(
            `insert into ${WORK_DEAD_TABLE}
               (id, kind, payload, provenance, attempts, last_error, dead_at)
             values ($1, $2, $3, $4, $5, $6, $7)
             on conflict (id) do nothing`,
            [
              row.id,
              row.kind,
              JSON.stringify(row.payload),
              JSON.stringify(row.provenance),
              row.attempts,
              error,
              at,
            ],
          );
          await tx.exec(`delete from ${WORK_TABLE} where id = $1`, [row.id]);
        });
        return;
      }

      await db.exec(
        `update ${WORK_TABLE}
            set lease_until = null,
                lease_owner = null,
                last_error = $2,
                next_attempt_at = $4::timestamptz + ($3 || ' milliseconds')::interval
          where id = $1`,
        [id, error, String(backoff(row.attempts)), at],
      );
    },

    async deadLetters() {
      return db.query<{ id: string; kind: string; error: string }>(
        `select id, kind, last_error as error from ${WORK_DEAD_TABLE}
          order by dead_at`,
      );
    },

    async pending() {
      const row = await db.queryRow<{ n: string }>(
        `select count(*)::text as n from ${WORK_TABLE}`,
      );
      return Number(row?.n ?? 0);
    },
  };
}
