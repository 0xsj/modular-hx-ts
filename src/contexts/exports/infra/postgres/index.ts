/**
 * PostgreSQL. **`exports` infra.**
 *
 * nolint:tenant — an export is reached by its own id or its operation's, and
 * both are compared against the caller's ownership one layer up. A tenant
 * filter here would turn a 404 into a row this adapter silently could not see,
 * and the `M3` rule is about statements returning other people's data.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import {
  type DB,
  type Postgres,
  asAppError,
} from '../../../../shared/postgres/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { postgresOperations } from '../../../../shared/operations/index.js';
import { postgresQueue } from '../../../../shared/work/index.js';
import { type Random } from '../../../../shared/random/index.js';
import {
  type Dataset,
  type ExportId,
  type Format,
  Export,
  exportId,
} from '../../domain/index.js';
import { type Exports, type Transactor, type Work } from '../../app/ports.js';
import { EXPORTS_TABLE } from './schema.js';

interface Row {
  readonly id: string;
  readonly operation_id: string;
  readonly dataset: string;
  readonly format: string;
  readonly requested_by: string;
  readonly tenant: string;
  readonly blob_key: string | null;
  readonly rows: string | null;
  readonly bytes: string | null;
  readonly expires_at: Date | null;
  readonly requested_at: Date;
  readonly version: number;
}

const COLUMNS =
  'id, operation_id, dataset, format, requested_by, tenant, blob_key, rows, bytes, expires_at, requested_at, version';

function toExport(row: Row): Export {
  return Export.from({
    id: exportId(row.id),
    operationId: row.operation_id,
    dataset: row.dataset as Dataset,
    format: row.format as Format,
    requestedBy: row.requested_by,
    tenant: row.tenant,
    ...(row.blob_key === null ? {} : { blobKey: row.blob_key }),
    // `bigint` arrives as text so a count past 2^53 is not silently wrong.
    ...(row.rows === null ? {} : { rows: Number(row.rows) }),
    ...(row.bytes === null ? {} : { bytes: Number(row.bytes) }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    requestedAt: row.requested_at,
    version: row.version,
  });
}

export function postgresExports(db: DB): Exports {
  return {
    async byId(id: ExportId) {
      const row = await db
        .queryRow<Row>(
          `select ${COLUMNS} from ${EXPORTS_TABLE} where id = $1`, // nolint:tenant — ownership is compared one layer up
          [id],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'read an export');
        });
      return row === undefined ? undefined : toExport(row);
    },

    async byOperation(operationId) {
      const row = await db.queryRow<Row>(
        `select ${COLUMNS} from ${EXPORTS_TABLE} where operation_id = $1`, // nolint:tenant — ownership is compared one layer up
        [operationId],
      );
      return row === undefined ? undefined : toExport(row);
    },

    async expired(now, limit) {
      const rows = await db.query<Row>(
        // nolint:tenant — the sweep is fleet-wide by design; scoping it by
        // tenant would leave one tenant's artifacts paid for forever
        `select ${COLUMNS} from ${EXPORTS_TABLE}
          where blob_key is not null and expires_at <= $1
          order by expires_at
          limit $2`,
        [now, limit],
      );
      return rows.map(toExport);
    },

    async create(row, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = row.toState();
      try {
        await target.exec(
          // nolint:tenant — the tenant is a column being written, not a filter
          `insert into ${EXPORTS_TABLE}
             (id, operation_id, dataset, format, requested_by, tenant,
              blob_key, rows, bytes, expires_at, requested_at, version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            state.id,
            state.operationId,
            state.dataset,
            state.format,
            state.requestedBy,
            state.tenant,
            state.blobKey ?? null,
            state.rows ?? null,
            state.bytes ?? null,
            state.expiresAt ?? null,
            state.requestedAt,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'request an export');
      }
    },

    async save(row, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = row.toState();
      const updated = await target
        .exec(
          // nolint:tenant — addressed by primary key, ownership compared above
          `update ${EXPORTS_TABLE}
              set blob_key = $1, rows = $2, bytes = $3, expires_at = $4,
                  version = $5
            where id = $6 and version = $7`,
          [
            state.blobKey ?? null,
            state.rows ?? null,
            state.bytes ?? null,
            state.expiresAt ?? null,
            state.version,
            state.id,
            row.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save an export');
        });

      if (updated === 0) {
        throw conflict(`export ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },
  };
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
          exports: postgresExports(tx),
          // **All three bound to the same handle.** The export row, the
          // operation and the queue entry are one commit — any two without the
          // third is a state nobody has code for.
          operations: postgresOperations(tx as unknown as Postgres),
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
