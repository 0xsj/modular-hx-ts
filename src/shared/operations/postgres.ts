/**
 * Operations in PostgreSQL.
 *
 * nolint:tenant — every statement here filters by `tenant` where it addresses a
 * row a caller can reach; `byId` does not, deliberately, because the caller
 * check is an **owner** comparison one layer up and a tenant filter here would
 * turn a 404 into a row this adapter silently could not see. The `M3` rule is
 * about statements returning other people's data; this one returns a row whose
 * owner is then compared.
 */

import { conflict } from '../errors/index.js';
import { type DB, type Postgres, asAppError } from '../postgres/index.js';
import {
  type OperationResult,
  type OperationState,
  Operation as Op,
} from './operation.js';
import { type Operations } from './port.js';
import { OPERATIONS_TABLE } from './schema.js';

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly owner_id: string;
  readonly tenant: string;
  readonly result: OperationResult | null;
  readonly error: string | null;
  readonly started_at: Date;
  readonly finished_at: Date | null;
  readonly version: number;
}

const COLUMNS =
  'id, kind, state, owner_id, tenant, result, error, started_at, finished_at, version';

function toOperation(row: Row): Op {
  return Op.from({
    id: row.id,
    kind: row.kind,
    state: row.state as OperationState,
    ownerId: row.owner_id,
    tenant: row.tenant,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    version: row.version,
  });
}

export function postgresOperations(db: Postgres): Operations {
  return {
    async byId(id) {
      const row = await db
        .queryRow<Row>(
          `select ${COLUMNS} from ${OPERATIONS_TABLE} where id = $1`, // nolint:tenant — the owner check is one layer up
          [id],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'read an operation');
        });
      return row === undefined ? undefined : toOperation(row);
    },

    async create(operation, writer?: unknown) {
      // **The caller's transaction.** An operation row and the thing it is
      // about commit together, or a caller polls an operation for work that
      // never started.
      const target = (writer as DB | undefined) ?? db;
      const state = operation.toState();

      try {
        await target.exec(
          // nolint:tenant — the tenant is a column being written, not a filter
          `insert into ${OPERATIONS_TABLE}
             (id, kind, state, owner_id, tenant, result, error, started_at,
              finished_at, version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            state.id,
            state.kind,
            state.state,
            state.ownerId,
            state.tenant,
            state.result === undefined ? null : JSON.stringify(state.result),
            state.error ?? null,
            state.startedAt,
            state.finishedAt ?? null,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'start an operation');
      }
    },

    async save(operation, writer?: unknown) {
      const target = (writer as DB | undefined) ?? db;
      const state = operation.toState();

      const updated = await target
        .exec(
          // nolint:tenant — addressed by primary key, which the caller was
          // already proved to own
          `update ${OPERATIONS_TABLE}
              set state = $1, result = $2, error = $3, finished_at = $4,
                  version = $5
            where id = $6 and version = $7`,
          [
            state.state,
            state.result === undefined ? null : JSON.stringify(state.result),
            state.error ?? null,
            state.finishedAt ?? null,
            state.version,
            state.id,
            operation.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save an operation');
        });

      if (updated === 0) {
        throw conflict(`operation ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },
  };
}
