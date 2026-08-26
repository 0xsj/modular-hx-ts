/**
 * The context root, and the only way in — `CONTEXTS.md` §8 step 6.
 *
 * **The first context that binds three substrate modules**: `work` runs it,
 * `blob` holds the artifact, `operations` is what a caller polls. Each was
 * built for this and none of them knows about it.
 *
 * See `notes/domain/exports.md`.
 */

import { type Subject } from '../../shared/authz/index.js';
import { type Blobs } from '../../shared/blob/index.js';
import { type Clock } from '../../shared/clock/index.js';
import { type Exchange, type Handler } from '../../shared/edge/index.js';
import { type Publisher } from '../../shared/events/index.js';
import { type AnyRoute } from '../../shared/httproute/index.js';
import { type IdGenerator } from '../../shared/id/index.js';
import {
  type Operations,
  memoryOperationStore,
  memoryOperations,
  postgresOperations,
} from '../../shared/operations/index.js';
import { type Postgres } from '../../shared/postgres/index.js';
import { type Provenance } from '../../shared/provenance/index.js';
import { type Random } from '../../shared/random/index.js';
import {
  type Job,
  type Queue,
  memoryQueue,
  memoryWorkStore,
  postgresQueue,
} from '../../shared/work/index.js';
import { type Datasets, type ExportsDeps } from './app/ports.js';
import { runExport } from './app/task/run.js';
import { sweepExpired } from './app/task/sweep.js';
import {
  type ExportStore,
  memoryExports,
  memoryStore,
  memoryTransactor,
} from './infra/memory/index.js';
import { postgresExports, postgresTransactor } from './infra/postgres/index.js';
import { exportsMigrations } from './infra/postgres/schema.js';
import { exportRouter, exportRoutes } from './transport/http/routes.js';

/** A day. Long enough to fetch, short enough not to be storage nobody owns. */
const DEFAULT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ExportsOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly publisher: Publisher;
  readonly blobs: Blobs;
  readonly datasets: Datasets;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  readonly artifactTtlMs?: number;
  readonly caller: (exchange: Exchange) => Subject | undefined;
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
}

export interface ExportsContext {
  readonly deps: ExportsDeps;
  readonly handler: Handler;
  readonly routes: readonly AnyRoute<Subject>[];
  readonly migrations: typeof exportsMigrations;
  readonly queue: Queue;
  /**
   * What a `work` worker calls. **The context supplies the handler**, so the
   * root wires a queue to a function rather than knowing what an export is.
   */
  readonly handle: (job: Job) => Promise<void>;
  /** The `jobs` step that drops expired artifacts. */
  readonly sweep: (provenance: Provenance) => Promise<number>;
  readonly store?: ExportStore;
}

export function makeExports(options: ExportsOptions): ExportsContext {
  const { db } = options;

  const operations: Operations =
    db === undefined
      ? memoryOperations(memoryOperationStore())
      : postgresOperations(db);

  const queue: Queue =
    db === undefined
      ? memoryQueue({ store: memoryWorkStore(), ids: options.ids })
      : postgresQueue({
          db,
          ids: options.ids,
          random: options.random,
        });

  const backing =
    db === undefined
      ? (() => {
          const store = memoryStore();
          return {
            store,
            exports: memoryExports(store),
            transactor: memoryTransactor({
              store,
              operations,
              queue,
              publisher: options.publisher,
            }),
          };
        })()
      : {
          store: undefined,
          exports: postgresExports(db),
          transactor: postgresTransactor({
            db,
            publisher: options.publisher,
            ids: options.ids,
            random: options.random,
          }),
        };

  const deps: ExportsDeps = {
    transactor: backing.transactor,
    exports: backing.exports,
    operations,
    queue,
    blobs: options.blobs,
    datasets: options.datasets,
    publisher: options.publisher,
    clock: options.clock,
    ids: options.ids,
    artifactTtlMs: options.artifactTtlMs ?? DEFAULT_ARTIFACT_TTL_MS,
  };

  const routes = exportRoutes({
    deps,
    caller: options.caller,
    ...(options.onUndeclared === undefined
      ? {}
      : { onUndeclared: options.onUndeclared }),
  });

  return {
    deps,
    routes,
    handler: exportRouter({
      deps,
      caller: options.caller,
      ...(options.onUndeclared === undefined
        ? {}
        : { onUndeclared: options.onUndeclared }),
    }),
    migrations: exportsMigrations,
    queue,
    handle: async (job: Job) => {
      // One kind today. A `switch` rather than an `if`, because the second kind
      // is a case rather than a rewrite.
      switch (job.kind) {
        case 'export': {
          const { exportId: id } = job.payload as { exportId: string };
          await runExport(deps, id, job.provenance);
          return;
        }
        default:
          // Not ours. Returning rather than throwing, because a shared queue
          // with another context's job in it is not this context's failure.
          return;
      }
    },
    sweep: (provenance) => sweepExpired(deps, provenance),
    ...(backing.store === undefined ? {} : { store: backing.store }),
  };
}

export { exportsMigrations } from './infra/postgres/schema.js';
export { Dataset, Format } from './domain/index.js';
export type { Datasets, ExportsDeps } from './app/ports.js';
