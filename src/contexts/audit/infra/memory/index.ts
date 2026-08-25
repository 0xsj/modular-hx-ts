/**
 * The in-memory adapter. **`audit` infra.**
 *
 * `STORAGE=memory`, invariant `I1`. The dedupe is a `Set` of event ids, which
 * is the same property the unique index provides and — for one process — the
 * same guarantee.
 *
 * See `notes/domain/audit.md`.
 */

import {
  type AuditQuery,
  type AuditRecord,
  type Scope,
} from '../../domain/index.js';
import { type AuditLog } from '../../app/ports.js';

export interface AuditStore {
  readonly records: AuditRecord[];
  readonly seen: Set<string>;
}

export function memoryStore(): AuditStore {
  return { records: [], seen: new Set() };
}

/** Scope first, then the filter — the two AND, and neither replaces the other. */
function visible(record: AuditRecord, scope: Scope): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'own':
      return (
        record.state.actor === scope.id || record.state.subject === scope.id
      );
  }
}

function matches(record: AuditRecord, query: AuditQuery): boolean {
  const { state } = record;

  if (query.actor !== undefined && state.actor !== query.actor) return false;
  if (query.subject !== undefined && state.subject !== query.subject) {
    return false;
  }
  if (query.event !== undefined && state.event !== query.event) return false;
  if (query.prefix !== undefined && !state.event.startsWith(query.prefix)) {
    return false;
  }
  if (
    query.correlationId !== undefined &&
    state.correlationId !== query.correlationId
  ) {
    return false;
  }
  if (
    query.since !== undefined &&
    state.occurredAt.getTime() < query.since.getTime()
  ) {
    return false;
  }
  if (
    query.until !== undefined &&
    state.occurredAt.getTime() > query.until.getTime()
  ) {
    return false;
  }
  return true;
}

export function memoryAuditLog(store: AuditStore): AuditLog {
  return {
    append(record) {
      // **Idempotent by event id** — case 36. A redelivery reports `false`
      // rather than throwing: at-least-once means redelivery is normal.
      if (store.seen.has(record.eventId)) return Promise.resolve(false);
      store.seen.add(record.eventId);
      store.records.push(record);
      return Promise.resolve(true);
    },

    search(query, scope) {
      const found = store.records
        .filter((record) => visible(record, scope) && matches(record, query))
        // Newest first, by when the thing **happened** rather than when it was
        // recorded: a redelivery an hour late is still a fact about an hour ago.
        .sort(
          (a, b) => b.state.occurredAt.getTime() - a.state.occurredAt.getTime(),
        )
        .slice(0, query.limit);

      return Promise.resolve(found);
    },
  };
}
