/**
 * In-memory operations. **`STORAGE=memory` is a real mode** — `I1`.
 */

import { conflict } from '../errors/index.js';
import {
  type Operation,
  type OperationState_,
  Operation as Op,
} from './operation.js';
import { type Operations } from './port.js';

export interface OperationStore {
  readonly rows: Map<string, OperationState_>;
}

export function memoryOperationStore(): OperationStore {
  return { rows: new Map() };
}

export function memoryOperations(store: OperationStore): Operations {
  return {
    byId(id) {
      const row = store.rows.get(id);
      return Promise.resolve(row === undefined ? undefined : Op.from(row));
    },

    create(operation: Operation) {
      const state = operation.toState();
      if (store.rows.has(state.id)) {
        // **A rejection, not a throw.** A port method declared `Promise<void>`
        // that throws *synchronously* is one a caller cannot `.catch()`, and
        // the difference from the PostgreSQL adapter — async by construction —
        // is invisible until somebody writes `create(x).catch(...)` and the
        // process dies instead of recovering. `Promise.reject` says so at the
        // call site rather than as a side effect of an `async` keyword the
        // linter then objects to for having nothing to await.
        return Promise.reject(conflict(`operation ${state.id} already exists`));
      }
      store.rows.set(state.id, state);
      return Promise.resolve();
    },

    save(operation: Operation) {
      const state = operation.toState();
      const current = store.rows.get(state.id);
      if (current?.version !== operation.baseVersion) {
        return Promise.reject(
          conflict(`operation ${state.id} was modified by somebody else`, {
            problem: 'version-conflict',
          }),
        );
      }
      store.rows.set(state.id, state);
      return Promise.resolve();
    },
  };
}
