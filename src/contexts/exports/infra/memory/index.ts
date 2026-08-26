/**
 * The in-memory store. **`STORAGE=memory` is a real mode** — `I1`.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import { type Operations } from '../../../../shared/operations/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { type Queue } from '../../../../shared/work/index.js';
import { type ExportId, type ExportState, Export } from '../../domain/index.js';
import { type Exports, type Transactor, type Work } from '../../app/ports.js';

export interface ExportStore {
  readonly rows: Map<string, ExportState>;
}

export function memoryStore(): ExportStore {
  return { rows: new Map() };
}

export function memoryExports(store: ExportStore): Exports {
  return {
    byId(id: ExportId) {
      const row = store.rows.get(id);
      return Promise.resolve(row === undefined ? undefined : Export.from(row));
    },

    byOperation(operationId) {
      const row = [...store.rows.values()].find(
        (one) => one.operationId === operationId,
      );
      return Promise.resolve(row === undefined ? undefined : Export.from(row));
    },

    expired(now, limit) {
      return Promise.resolve(
        [...store.rows.values()]
          .filter(
            (one) =>
              one.blobKey !== undefined &&
              one.expiresAt !== undefined &&
              one.expiresAt.getTime() <= now.getTime(),
          )
          .slice(0, limit)
          .map((one) => Export.from(one)),
      );
    },

    create(row) {
      const state = row.toState();
      if (store.rows.has(state.id)) {
        return Promise.reject(conflict(`export ${state.id} already exists`));
      }
      store.rows.set(state.id, state);
      return Promise.resolve();
    },

    save(row) {
      const state = row.toState();
      const current = store.rows.get(state.id);
      if (current?.version !== row.baseVersion) {
        return Promise.reject(
          conflict(`export ${state.id} was modified by somebody else`, {
            problem: 'version-conflict',
          }),
        );
      }
      store.rows.set(state.id, state);
      return Promise.resolve();
    },
  };
}

export function memoryTransactor(options: {
  store: ExportStore;
  operations: Operations;
  queue: Queue;
  publisher: Publisher;
}): Transactor {
  const { store, publisher } = options;

  return {
    async within<T>(work: (handle: Work) => Promise<T>): Promise<T> {
      const snapshot = new Map(store.rows);

      const handle: Work = {
        exports: memoryExports(store),
        operations: options.operations,
        queue: options.queue,
        // **`undefined`, honestly.** There is no handle in memory mode, and
        // handing out a fake one would let a caller believe it had joined
        // something.
        writer: undefined,
        publish: async (event: Event, provenance: Provenance) => {
          await publisher.publish(event, provenance);
        },
      };

      try {
        return await work(handle);
      } catch (error) {
        store.rows.clear();
        for (const [k, v] of snapshot) store.rows.set(k, v);
        throw error;
      }
    },
  };
}
