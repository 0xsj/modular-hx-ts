/**
 * The bucket table. **L4 edge.**
 *
 * Namespaced `ratelimit`, not a context: like the outbox and the idempotency
 * records, this is infrastructure every context's edge sits behind, and rule
 * `M7` only requires that no two contexts *share* a namespace.
 *
 * **One row per caller, and the row is the bucket.** There is no history here
 * and there should not be: a rate limiter needs to know how many tokens you
 * have, not how you spent them. Anything wanting the second is an audit
 * question and belongs in `audit`.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { type MigrationSet } from '../postgres/index.js';

export const BUCKETS_TABLE = 'rate_limit_buckets';

export const ratelimitMigrations: MigrationSet = [
  {
    context: 'ratelimit',
    name: '0001_buckets',
    sql: `
      create table ${BUCKETS_TABLE} (
        -- 'principal:user:01a0...' or 'peer:203.0.113.7'. Prefixed by kind so
        -- an address can never collide with an actor id.
        key      text        primary key,

        -- Fractional on purpose. Rounding to whole tokens on every write turns
        -- a steady stream of requests into a bucket that never refills: each
        -- write floors away the fraction that had just accrued.
        tokens   float8      not null,

        -- The database's clock, because PostgreSQL exposes no monotonic one.
        -- The clamps in bucket.ts bound what a clock correction can cost; see
        -- postgres.ts.
        read_at  timestamptz not null default now()
      );

      -- The purge job's only query. Not partial, for the reason the outbox
      -- learned against a real database: now() is STABLE rather than IMMUTABLE
      -- and cannot appear in an index predicate (SQLSTATE 42P17).
      create index ${BUCKETS_TABLE}_idle on ${BUCKETS_TABLE} (read_at);
    `,
  },
];
