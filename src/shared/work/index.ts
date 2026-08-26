/**
 * A durable queue. **L2 substrate.**
 *
 * > enqueue in your transaction, leased worker, retry, dead-letter
 *
 * The first clause is the design. See `notes/patterns/work.md`.
 */

export type { Enqueued, Job, Queue } from './port.js';
export {
  type MemoryOptions,
  type WorkStore,
  memoryQueue,
  memoryWorkStore,
} from './memory.js';
export { type PostgresOptions, postgresQueue } from './postgres.js';
export { WORK_TABLE, WORK_DEAD_TABLE, workMigrations } from './schema.js';
export { type WorkerOptions, worker } from './worker.js';
