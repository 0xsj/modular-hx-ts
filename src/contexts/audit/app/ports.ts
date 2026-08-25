/**
 * The out-ports `audit` needs. **Two methods, and one of them is a read.**
 *
 * **Append-only**: there is no `save`, no `update` and no `delete`, and their
 * absence is the design rather than an omission. A port that could edit a
 * record is one somebody eventually calls.
 *
 * See `notes/domain/audit.md`.
 */

import {
  type AuditQuery,
  type AuditRecord,
  type Scope,
} from '../domain/index.js';

export interface AuditLog {
  /**
   * Record it, or do nothing.
   *
   * **Idempotent by event id** — conformance case 36. Returns whether a row was
   * added, which is what makes the property assertable rather than assumed: a
   * redelivery reports `false` and the caller can count it.
   *
   * A duplicate is **not an error**. At-least-once delivery means redelivery is
   * normal traffic, and a subscriber that threw on it would dead-letter its way
   * through a perfectly healthy queue.
   */
  append(record: AuditRecord): Promise<boolean>;

  /** Newest first, scoped — case 37. */
  search(query: AuditQuery, scope: Scope): Promise<readonly AuditRecord[]>;
}
