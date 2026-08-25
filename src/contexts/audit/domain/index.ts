/**
 * The `audit` domain. **Imports only `errors`** — rule `S7`.
 *
 * Small, and small is the point: `audit` records what other contexts did, and
 * everything it records arrived on an event. There are no invariants spanning
 * records because there is no relationship between them — an audit log is a
 * set of facts, not a model.
 */

export {
  type AuditRecordState,
  type RecordId,
  AuditRecord,
  recordId,
} from './record.js';

export { type AuditQuery, type Scope, MAX_LIMIT, auditQuery } from './query.js';
