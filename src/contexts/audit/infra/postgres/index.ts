/**
 * The PostgreSQL adapter. **`audit` infra.**
 *
 * The same contract suite the memory adapter passes, plus the one thing only a
 * database provides: **idempotency that holds across processes.** The memory
 * adapter's `Set` is the same guarantee for one process; four replicas draining
 * the same outbox need the unique index.
 *
 * **nolint:tenant — the tenant is recorded here, not filtered on.** The reason
 * is in `schema.ts`, and the protection a tenant column would give is provided
 * by `Scope` on every read, which is per **caller** rather than per tenant.
 *
 * See `notes/domain/audit.md`.
 */

import {
  asAppError,
  escapeLike,
  type DB,
} from '../../../../shared/postgres/index.js';
import {
  type AuditQuery,
  type Scope,
  AuditRecord,
  recordId,
} from '../../domain/index.js';
import { type AuditLog } from '../../app/ports.js';
import { RECORDS_TABLE } from './schema.js';

interface Row {
  readonly id: string;
  readonly event_id: string;
  readonly event: string;
  readonly actor: string;
  readonly subject: string | null;
  readonly request_id: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly tenant: string | null;
  readonly traceparent: string | null;
  readonly occurred_at: Date;
  readonly recorded_at: Date;
}

const COLUMNS =
  'id, event_id, event, actor, subject, request_id, correlation_id, causation_id, tenant, traceparent, occurred_at, recorded_at';

/** `null` in a column means **absent**, never empty — case 38a. */
function toRecord(row: Row): AuditRecord {
  return AuditRecord.of({
    id: recordId(row.id),
    eventId: row.event_id,
    event: row.event,
    actor: row.actor,
    ...(row.subject === null ? {} : { subject: row.subject }),
    requestId: row.request_id,
    correlationId: row.correlation_id,
    ...(row.causation_id === null ? {} : { causationId: row.causation_id }),
    ...(row.tenant === null ? {} : { tenant: row.tenant }),
    ...(row.traceparent === null ? {} : { traceparent: row.traceparent }),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  });
}

export function postgresAuditLog(db: DB): AuditLog {
  return {
    async append(record) {
      const wire = record.state;
      try {
        // **`on conflict do nothing`** — conformance case 36. A redelivery adds
        // no row and raises nothing: at-least-once delivery means redelivery is
        // normal traffic, and a subscriber that threw would dead-letter its way
        // through a perfectly healthy queue.
        //
        // `rowCount` is what tells the caller which happened, which is what
        // makes the property assertable rather than assumed.
        const inserted = await db.exec(
          `insert into ${RECORDS_TABLE}
             (id, event_id, event, actor, subject, request_id, correlation_id,
              causation_id, tenant, traceparent, occurred_at, recorded_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           on conflict (event_id) do nothing`,
          [
            wire.id,
            wire.eventId,
            wire.event,
            wire.actor,
            wire.subject ?? null,
            wire.requestId,
            wire.correlationId,
            wire.causationId ?? null,
            wire.tenant ?? null,
            wire.traceparent ?? null,
            wire.occurredAt,
            wire.recordedAt,
          ],
        );
        return inserted > 0;
      } catch (error) {
        throw asAppError(error, 'record an audit entry');
      }
    },

    async search(query: AuditQuery, scope: Scope) {
      if (scope.kind === 'none') return [];

      const where: string[] = [];
      const params: unknown[] = [];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${String(params.length)}`;
      };

      // **The scope goes in first and is ANDed**, never merged into the filter.
      // A caller narrowing to `actor=somebody-else` must still see nothing, and
      // that is only true if the scope is a separate clause.
      if (scope.kind === 'own') {
        const id = bind(scope.id);
        where.push(`(actor = ${id} or subject = ${id})`);
      }

      if (query.actor !== undefined) where.push(`actor = ${bind(query.actor)}`);
      if (query.subject !== undefined) {
        where.push(`subject = ${bind(query.subject)}`);
      }
      if (query.event !== undefined) where.push(`event = ${bind(query.event)}`);
      if (query.prefix !== undefined) {
        // `escape '\'` is explicit: the default is backslash on most builds and
        // *not* guaranteed, and a pattern whose escapes are inert is a pattern
        // that matches more than it says.
        where.push(
          `event like ${bind(`${escapeLike(query.prefix)}%`)} escape '\\'`,
        );
      }
      if (query.correlationId !== undefined) {
        where.push(`correlation_id = ${bind(query.correlationId)}`);
      }
      if (query.since !== undefined) {
        where.push(`occurred_at >= ${bind(query.since)}`);
      }
      if (query.until !== undefined) {
        where.push(`occurred_at <= ${bind(query.until)}`);
      }

      const clause = where.length === 0 ? '' : `where ${where.join(' and ')}`;

      try {
        const rows = await db.query<Row>(
          `select ${COLUMNS} from ${RECORDS_TABLE}
            ${clause}
            order by occurred_at desc, id desc
            limit ${bind(query.limit ?? 50)}`,
          params,
        );
        return rows.map(toRecord);
      } catch (error) {
        throw asAppError(error, 'search audit records');
      }
    },
  };
}
