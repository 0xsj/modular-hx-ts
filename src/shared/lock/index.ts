/**
 * Distributed locks. **L2 substrate.**
 *
 * A named mutex behind a port, with a memory adapter for `STORAGE=memory` and
 * **session-scoped PostgreSQL advisory locks** for everything else.
 *
 * Advisory locks are the right adapter for one reason above the others: **a
 * crashed holder releases automatically.** The lock lives on the connection, so
 * a `SIGKILL`, an OOM or a severed network takes the backend with it and the
 * lock is free. No sweeper, no TTL that is a guess about how long a healthy
 * holder pauses, and no window in which a dead instance still owns the fleet's
 * singleton.
 *
 * `lock` has no consumer without `jobs`, and `jobs` cannot run a fleet-wide
 * singleton without `lock` — they are one unit of work.
 *
 * Note: `notes/patterns/lock.md`.
 */

export { type Lease, type LockOptions, type Locks } from './port.js';
export { JOBS_NAMESPACE, advisoryKey, qualify } from './key.js';
export { memoryLocks } from './memory.js';
export { postgresLocks } from './postgres.js';
