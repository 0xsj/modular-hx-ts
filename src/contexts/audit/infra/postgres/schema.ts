/**
 * `audit`'s table. **Append-only, and one index does the whole job.**
 *
 * **nolint:tenant — the tenant is a recorded field here, not a filter.**
 *
 * `M3` requires every statement in a context adapter to filter by tenant,
 * because *the violation does not error, it returns other people's data*. That
 * is right, and `audit` is the one context where it inverts: this table records
 * events from every context including ones with no tenant at all — a boot, a
 * migration, a job — and a `where tenant = $1` would silently hide exactly the
 * system actions an auditor is looking for.
 *
 * What protects a caller's records from another's is `Scope`, applied on every
 * read and ANDed with the filter rather than defaulted (see `index.ts`). It is
 * a stronger check than a tenant column would be, because it is per **caller**
 * rather than per tenant.
 *
 * See `notes/domain/audit.md`.
 */

import { type MigrationSet } from '../../../../shared/postgres/index.js';

export const RECORDS_TABLE = 'audit_records';

export const auditMigrations: MigrationSet = [
  {
    context: 'audit',
    name: '0001_records',
    sql: `
      create table ${RECORDS_TABLE} (
        id             uuid        primary key,

        -- **The event's id, and it is unique** -- conformance case 36.
        -- Delivery is at-least-once, so a redelivery must add no row, and the
        -- constraint is what makes that true under concurrency rather than a
        -- read-then-insert racing itself.
        event_id       uuid        not null,

        event          text        not null,
        actor          text        not null,

        -- Nullable, and it means **absent** rather than empty: an event about
        -- no particular subject exists, and filling this with the actor would
        -- make every such row a false claim about who was acted upon.
        subject        text,

        request_id     text        not null,

        -- Case 38: **X's** correlation id, carried from the envelope rather
        -- than minted here.
        correlation_id text        not null,
        causation_id   text,

        -- Recorded, never filtered on. See the note above.
        tenant         text,
        traceparent    text,

        occurred_at    timestamptz not null,
        recorded_at    timestamptz not null default now()
      );

      create unique index ${RECORDS_TABLE}_event on ${RECORDS_TABLE} (event_id);

      -- The three queries §3 names, in the order a planner wants them: newest
      -- first within whatever was filtered.
      create index ${RECORDS_TABLE}_actor
        on ${RECORDS_TABLE} (actor, occurred_at desc);
      create index ${RECORDS_TABLE}_subject
        on ${RECORDS_TABLE} (subject, occurred_at desc);
      create index ${RECORDS_TABLE}_correlation
        on ${RECORDS_TABLE} (correlation_id, occurred_at desc);

      -- The prefix query. **text_pattern_ops**, because the default opclass
      -- uses the database's collation and a \`like 'identity.%'\` will not use
      -- an index built with it -- which turns every prefix search into a scan
      -- of the whole log, and the whole log is the biggest table here.
      create index ${RECORDS_TABLE}_event_prefix
        on ${RECORDS_TABLE} (event text_pattern_ops);
    `,
  },
];
