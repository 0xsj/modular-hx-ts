/**
 * Long-running operations: **202, `Location`, poll, cancel.** L3 capability.
 *
 * A barrel, and deliberately nothing else. The record lives in `operation.ts`
 * and the adapters import it from there — `index.ts` holding the class made
 * every adapter import the barrel that re-exported them, which the cruiser's
 * `no-circular` caught on the first run. The same shape `httproute/statuses.ts`
 * had, for the same reason.
 *
 * See `notes/patterns/operations.md`.
 */

export {
  type OperationResult,
  type OperationState_,
  Operation,
  OperationState,
  invisible,
  isTerminal,
  locationOf,
} from './operation.js';
export type { Operations } from './port.js';
export {
  type OperationStore,
  memoryOperationStore,
  memoryOperations,
} from './memory.js';
export { postgresOperations } from './postgres.js';
export { OPERATIONS_TABLE, operationsMigrations } from './schema.js';
