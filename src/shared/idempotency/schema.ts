/**
 * The idempotency table. **L4 edge.**
 *
 * Namespaced `idempotency`, not a context: like the outbox, this is
 * infrastructure every context's mutating endpoints sit behind, and rule `M7`
 * only requires that no two contexts *share* a namespace.
 *
 * **The primary key is the scope, not the key.** `(tenant, principal, key)` —
 * a bare `key` primary key is the cross-tenant read `MODULES.md` §5 names, and
 * it is the kind of defect that looks like a schema simplification in review.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { type MigrationSet } from '../postgres/index.js';

export const RECORDS_TABLE = 'idempotency_records';

export const idempotencyMigrations: MigrationSet = [
  {
    context: 'idempotency',
    name: '0001_records',
    sql: `
      create table ${RECORDS_TABLE} (
        -- The scope. '' for tenant in single-tenant mode, which keeps that mode
        -- byte-identical to a build with no tenancy.
        tenant       text        not null,
        principal    text        not null,
        key          text        not null,

        -- Digest of the canonical request, never of the raw bytes: a
        -- re-serialized but identical payload must not read as a different one.
        fingerprint  text        not null,

        -- Absent while in flight, present once the handler finished.
        status       int,
        headers      jsonb,
        body         text,

        -- Finished, and nothing to replay: the response was past the storage
        -- cap. A separate column rather than a sentinel status, because
        -- "spent" and "answered 204" are different facts and a reader of this
        -- table needs to tell them apart.
        consumed     boolean     not null default false,

        -- Ownership: how long this claim is honoured before the claimant is
        -- presumed dead. Null once completed.
        lease_until  timestamptz,
        -- Replayability: how long the stored response is served. Null while in
        -- flight. A different question from the one above, which is why it is a
        -- different column.
        expires_at   timestamptz,

        claimed_at   timestamptz not null default now(),

        primary key (tenant, principal, key)
      );

      -- The purge job's only query. Not a partial index: the obvious predicate
      -- is "where expires_at < now()" and PostgreSQL refuses it, because now()
      -- is STABLE rather than IMMUTABLE and the index would need rebuilding
      -- every time the clock moved. SQLSTATE 42P17 -- the same lesson the
      -- outbox learned against a real database and nothing before it.
      create index ${RECORDS_TABLE}_expiry on ${RECORDS_TABLE} (expires_at);
    `,
  },
];
