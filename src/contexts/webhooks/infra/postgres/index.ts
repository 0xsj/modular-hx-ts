/**
 * PostgreSQL. **`webhooks` infra.**
 *
 * nolint:tenant — an endpoint is reached by its own id and compared against the
 * caller's ownership one layer up, or by the fan-out, which is deliberately
 * installation-wide. A tenant filter here would turn a 404 into a row this
 * adapter silently could not see.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import {
  type DB,
  type Postgres,
  asAppError,
} from '../../../../shared/postgres/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { type Random } from '../../../../shared/random/index.js';
import { postgresQueue } from '../../../../shared/work/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import {
  type Cursor,
  decodeCursor,
  paginate,
} from '../../../../shared/pagination/index.js';
import {
  type Attempt,
  type DeliveryId,
  type DeliveryState,
  type DisabledBecause,
  type EndpointId,
  type EndpointState,
  Delivery,
  Endpoint,
  deliveryId,
  endpointId,
} from '../../domain/index.js';
import {
  type Deliveries,
  type Endpoints,
  type Transactor,
  type Work,
} from '../../app/ports.js';
import { DELIVERIES_TABLE, ENDPOINTS_TABLE } from './schema.js';

interface EndpointRow {
  readonly id: string;
  readonly owner_id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly secret_fingerprint: string;
  readonly state: string;
  readonly disabled_because: string | null;
  readonly consecutive_failures: number;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: number;
}

const ENDPOINT_COLUMNS =
  'id, owner_id, url, events, secret_fingerprint, state, disabled_because, consecutive_failures, created_at, updated_at, version';

function toEndpoint(row: EndpointRow): Endpoint {
  return Endpoint.from({
    id: endpointId(row.id),
    ownerId: row.owner_id,
    url: row.url,
    events: row.events,
    secretFingerprint: row.secret_fingerprint,
    state: row.state as EndpointState,
    ...(row.disabled_because === null
      ? {}
      : { disabledBecause: row.disabled_because as DisabledBecause }),
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

interface DeliveryRow {
  readonly id: string;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly event_name: string;
  readonly payload: string;
  readonly state: string;
  readonly attempts: readonly {
    at: string;
    status?: number;
    error?: string;
    tookMs: number;
  }[];
  readonly total_attempts: number;
  readonly attempts_this_round: number;
  readonly next_attempt_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version: number;
}

const DELIVERY_COLUMNS =
  'id, endpoint_id, event_id, event_name, payload, state, attempts, total_attempts, attempts_this_round, next_attempt_at, created_at, updated_at, version';

function toDelivery(row: DeliveryRow): Delivery {
  return Delivery.from({
    id: deliveryId(row.id),
    endpointId: endpointId(row.endpoint_id),
    eventId: row.event_id,
    eventName: row.event_name,
    payload: row.payload,
    state: row.state as DeliveryState,
    // **`jsonb` gives back a string date**, and an `Attempt` carries a `Date`.
    // Rehydrating here rather than leaving it is what stops a comparison
    // against another instant from being string-versus-Date and quietly false.
    attempts: row.attempts.map((one): Attempt => ({
      at: new Date(one.at),
      ...(one.status === undefined ? {} : { status: one.status }),
      ...(one.error === undefined ? {} : { error: one.error }),
      tookMs: one.tookMs,
    })),
    totalAttempts: row.total_attempts,
    attemptsThisRound: row.attempts_this_round,
    ...(row.next_attempt_at === null
      ? {}
      : { nextAttemptAt: row.next_attempt_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function positionFrom(order: string, cursor: Cursor | undefined): string {
  if (cursor === undefined) return '';
  const position = unwrap(decodeCursor(order, cursor));
  return typeof position === 'string' ? position : '';
}

export function postgresEndpoints(db: DB): Endpoints {
  return {
    async byId(id: EndpointId) {
      const row = await db
        .queryRow<EndpointRow>(
          `select ${ENDPOINT_COLUMNS} from ${ENDPOINTS_TABLE} where id = $1`, // nolint:tenant — ownership is compared one layer up
          [id],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'read a webhook endpoint');
        });
      return row === undefined ? undefined : toEndpoint(row);
    },

    async wanting(eventName) {
      // **The match is in SQL, and it is the same three rules the aggregate
      // applies**: the exact name, every `prefix.*` that covers it, and `*`.
      // The candidate list is built here rather than by scanning every
      // endpoint, so the GIN index answers it — a fan-out that loaded the whole
      // table would be one query per published event over every integration in
      // the installation.
      const patterns = [eventName, '*', ...prefixesOf(eventName)];

      const rows = await db.query<EndpointRow>(
        // nolint:tenant — fan-out is installation-wide by design
        `select ${ENDPOINT_COLUMNS} from ${ENDPOINTS_TABLE}
          where state = 'enabled' and events && $1
          order by created_at, id`,
        [patterns],
      );
      return rows.map(toEndpoint);
    },

    async list(query) {
      const from = positionFrom('webhooks.endpoints', query.cursor);
      const rows = await db.query<EndpointRow>(
        // nolint:tenant — scoped by owner, which is the subject one layer up
        `select ${ENDPOINT_COLUMNS} from ${ENDPOINTS_TABLE}
          where ($1::uuid is null or owner_id = $1)
            and ($2 = '' or id > $2::uuid)
          order by id
          limit $3`,
        [query.ownerId ?? null, from, query.limit + 1],
      );

      return unwrap(
        paginate(
          rows.map(toEndpoint),
          query.limit,
          'webhooks.endpoints',
          (one) => one.id,
        ),
      );
    },

    async create(endpoint, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = endpoint.toState();
      try {
        await target.exec(
          // nolint:tenant — the owner is a column being written, not a filter
          `insert into ${ENDPOINTS_TABLE}
             (id, owner_id, url, events, secret_fingerprint, state,
              disabled_because, consecutive_failures, created_at, updated_at,
              version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            state.id,
            state.ownerId,
            state.url,
            state.events,
            state.secretFingerprint,
            state.state,
            state.disabledBecause ?? null,
            state.consecutiveFailures,
            state.createdAt,
            state.updatedAt,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'register a webhook endpoint');
      }
    },

    async save(endpoint, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = endpoint.toState();
      const updated = await target
        .exec(
          // nolint:tenant — addressed by primary key, ownership compared above
          `update ${ENDPOINTS_TABLE}
              set url = $1, events = $2, secret_fingerprint = $3, state = $4,
                  disabled_because = $5, consecutive_failures = $6,
                  updated_at = $7, version = $8
            where id = $9 and version = $10`,
          [
            state.url,
            state.events,
            state.secretFingerprint,
            state.state,
            state.disabledBecause ?? null,
            state.consecutiveFailures,
            state.updatedAt,
            state.version,
            state.id,
            endpoint.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save a webhook endpoint');
        });

      if (updated === 0) {
        throw conflict(`endpoint ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },

    async remove(id, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      // nolint:tenant — ownership is compared one layer up
      await target.exec(`delete from ${ENDPOINTS_TABLE} where id = $1`, [id]);
    },
  };
}

export function postgresDeliveries(db: DB): Deliveries {
  return {
    async byId(id: DeliveryId) {
      const row = await db
        .queryRow<DeliveryRow>(
          `select ${DELIVERY_COLUMNS} from ${DELIVERIES_TABLE} where id = $1`, // nolint:tenant — ownership is the endpoint's, compared above
          [id],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'read a delivery');
        });
      return row === undefined ? undefined : toDelivery(row);
    },

    async list(query) {
      const from = positionFrom('webhooks.deliveries', query.cursor);
      const rows = await db.query<DeliveryRow>(
        // nolint:tenant — scoped by endpoint, whose owner was checked above
        `select ${DELIVERY_COLUMNS} from ${DELIVERIES_TABLE}
          where endpoint_id = $1
            and ($2 = '' or id < $2::uuid)
          order by id desc
          limit $3`,
        [query.endpointId, from, query.limit + 1],
      );

      return unwrap(
        paginate(
          rows.map(toDelivery),
          query.limit,
          'webhooks.deliveries',
          (one) => one.id,
        ),
      );
    },

    async create(delivery, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = delivery.toState();
      try {
        await target.exec(
          // nolint:tenant — the endpoint is a column being written
          `insert into ${DELIVERIES_TABLE}
             (id, endpoint_id, event_id, event_name, payload, state, attempts,
              total_attempts, attempts_this_round, next_attempt_at, created_at,
              updated_at, version)
           values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13)`,
          [
            state.id,
            state.endpointId,
            state.eventId,
            state.eventName,
            state.payload,
            state.state,
            JSON.stringify(state.attempts),
            state.totalAttempts,
            state.attemptsThisRound,
            state.nextAttemptAt ?? null,
            state.createdAt,
            state.updatedAt,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'queue a delivery');
      }
    },

    async save(delivery, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = delivery.toState();
      const updated = await target
        .exec(
          // nolint:tenant — addressed by primary key
          `update ${DELIVERIES_TABLE}
              set state = $1, attempts = $2::jsonb, total_attempts = $3,
                  attempts_this_round = $4, next_attempt_at = $5,
                  updated_at = $6, version = $7
            where id = $8 and version = $9`,
          [
            state.state,
            JSON.stringify(state.attempts),
            state.totalAttempts,
            state.attemptsThisRound,
            state.nextAttemptAt ?? null,
            state.updatedAt,
            state.version,
            state.id,
            delivery.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save a delivery');
        });

      if (updated === 0) {
        throw conflict(`delivery ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },

    async removeForEndpoint(id, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      // nolint:tenant — scoped by endpoint, whose owner was checked above
      await target.exec(
        `delete from ${DELIVERIES_TABLE} where endpoint_id = $1`,
        [id],
      );
    },
  };
}

/** `a.b.c` → `a.*`, `a.b.*`. Every prefix pattern that would match it. */
function prefixesOf(eventName: string): readonly string[] {
  const parts = eventName.split('.');
  return parts
    .slice(0, -1)
    .map((_part, index) => `${parts.slice(0, index + 1).join('.')}.*`);
}

export function postgresTransactor(options: {
  db: Postgres;
  publisher: Publisher;
  ids: { uuid(): string };
  random: Random;
}): Transactor {
  const { db, publisher } = options;

  return {
    within<T>(work: (handle: Work) => Promise<T>): Promise<T> {
      return db.withinTx(async (tx) => {
        const handle: Work = {
          endpoints: postgresEndpoints(tx),
          deliveries: postgresDeliveries(tx),
          // **The queue is bound to the same handle**, which is what makes the
          // fan-out atomic: N delivery rows and N jobs, or none of either.
          queue: postgresQueue({
            db: tx as unknown as Postgres,
            ids: options.ids,
            random: options.random,
          }),
          writer: tx,
          publish: async (event: Event, provenance: Provenance) => {
            await publisher.publish(event, provenance, tx);
          },
        };
        return work(handle);
      });
    },
  };
}
