/**
 * `identity`'s tables. **Its own schema, its own migrations** — a context owns
 * its storage and nothing else reads it.
 *
 * **nolint:tenant — this file is DDL, and DDL has no tenant to filter by.**
 *
 * `M3` scans for `select|update|delete` and these migrations match on
 * `on delete cascade`, which is a foreign-key action rather than a query. The
 * rule's own documentation names `create table` as the case the marker exists
 * for, so this is the escape hatch working as designed rather than a rule being
 * bent — and it is a reviewable line in a diff rather than a silent omission.
 *
 * The substantive reason `identity` is not tenant-scoped at all is in
 * `index.ts` beside the queries it applies to.
 *
 * See `notes/domain/identity.md`.
 */

import { type MigrationSet } from '../../../../shared/postgres/index.js';

export const USERS_TABLE = 'identity_users';
export const SESSIONS_TABLE = 'identity_sessions';
export const CHALLENGES_TABLE = 'identity_challenges';
export const API_KEYS_TABLE = 'identity_api_keys';

export const identityMigrations: MigrationSet = [
  {
    context: 'identity',
    name: '0001_users_and_sessions',
    sql: `
      create table ${USERS_TABLE} (
        id            uuid        primary key,

        -- Already lowercased and trimmed by the value object, so the unique
        -- index below is a plain one. A functional index on lower(email) would
        -- be a *second* normalization, and the two would eventually disagree
        -- about some address neither of them was written for.
        email         text        not null,

        -- **Null means no password**, and that is the storage shape of §2.2's
        -- "a user is not their credentials". A NOT NULL column would force an
        -- invented value for every SSO user, and an invented value is one
        -- somebody eventually compares against.
        password_hash text,

        roles         text[]      not null default '{}',
        enabled       boolean     not null,

        -- Optimistic concurrency. Repositories update on (id, version).
        version       int         not null,

        created_at    timestamptz not null,
        updated_at    timestamptz not null
      );

      create unique index ${USERS_TABLE}_email on ${USERS_TABLE} (email);

      create table ${SESSIONS_TABLE} (
        id                uuid        primary key,

        -- Cascade: a deleted user's sessions are not a thing that should
        -- outlive them, and a foreign key is the only cross-aggregate
        -- invariant §2.2 admits between these two.
        user_id           uuid        not null
                          references ${USERS_TABLE}(id) on delete cascade,

        -- **A fingerprint, never a token.** A dump of this table yields no
        -- usable sessions.
        token_fingerprint text        not null,

        -- How the session was created. One value today; the column exists now
        -- because backfilling a guess for every existing row later is not a
        -- migration anybody can get right.
        method            text        not null,

        issued_at         timestamptz not null,
        expires_at        timestamptz not null,
        last_seen_at      timestamptz not null,
        revoked_at        timestamptz,
        version           int         not null
      );

      -- The per-request lookup, and it must be unique: two sessions sharing a
      -- fingerprint would mean two tokens hashing alike, which is a bug worth
      -- failing a write over rather than resolving by picking one.
      create unique index ${SESSIONS_TABLE}_fingerprint
        on ${SESSIONS_TABLE} (token_fingerprint);

      -- The revoke sweep and the session list. Not partial on revoked_at:
      -- now() is STABLE rather than IMMUTABLE and cannot appear in an index
      -- predicate, which is SQLSTATE 42P17 and a lesson the outbox already
      -- paid for.
      create index ${SESSIONS_TABLE}_user on ${SESSIONS_TABLE} (user_id);
    `,
  },
  {
    context: 'identity',
    name: '0002_challenges',
    sql: `
      create table ${CHALLENGES_TABLE} (
        id                 uuid        primary key,
        user_id            uuid        not null
                           references ${USERS_TABLE}(id) on delete cascade,

        -- verify_email | reset_password | change_email | magic_link. One
        -- aggregate, many purposes -- CONTEXTS.md §2.2.
        purpose            text        not null,

        -- **A fingerprint, never the emailed secret.**
        secret_fingerprint text        not null,

        -- The MAC over (id, user, purpose). Binding the purpose is what stops
        -- a reset secret being replayed as a magic link.
        tag                text        not null,

        -- What the challenge does when consumed -- a new address, for
        -- change_email. Captured at **issue** time, so holding the link cannot
        -- redirect it.
        payload            text        not null default '',

        issued_at          timestamptz not null,
        expires_at         timestamptz not null,
        consumed_at        timestamptz,

        -- §7.7: idempotency is **modelled, not middleware**. Unique, so an
        -- at-least-once redelivery cannot issue a second link.
        source_event_id    uuid,

        version            int         not null
      );

      create unique index ${CHALLENGES_TABLE}_fingerprint
        on ${CHALLENGES_TABLE} (secret_fingerprint);

      -- Partial, and legal: the predicate is IS NOT NULL rather than anything
      -- involving now(), so it is IMMUTABLE and PostgreSQL accepts it. Two
      -- rows with no source event are not duplicates of each other.
      create unique index ${CHALLENGES_TABLE}_source_event
        on ${CHALLENGES_TABLE} (source_event_id)
        where source_event_id is not null;

      -- Case 14's sweep: the user's other outstanding links of one purpose.
      create index ${CHALLENGES_TABLE}_outstanding
        on ${CHALLENGES_TABLE} (user_id, purpose);
    `,
  },
  {
    context: 'identity',
    name: '0003_api_keys',
    sql: `
      create table ${API_KEYS_TABLE} (
        id           uuid        primary key,
        user_id      uuid        not null
                     references ${USERS_TABLE}(id) on delete cascade,
        name         text        not null,

        -- **A fingerprint, never the key.** Conformance case 16 says a key is
        -- shown once and never returned again, and that is only true if it
        -- cannot be returned.
        fingerprint  text        not null,

        -- 'resource:verb' actions. **Empty means the key can do nothing**, not
        -- everything -- an empty list read as unrestricted is the expensive way
        -- to get case 17 wrong.
        scopes       text[]      not null default '{}',

        created_at   timestamptz not null,
        last_used_at timestamptz,
        expires_at   timestamptz,
        revoked_at   timestamptz,
        version      int         not null
      );

      create unique index ${API_KEYS_TABLE}_fingerprint
        on ${API_KEYS_TABLE} (fingerprint);
      create index ${API_KEYS_TABLE}_user on ${API_KEYS_TABLE} (user_id);
    `,
  },
  {
    context: 'identity',
    name: '0003_user_display_name',
    sql: `
      -- **A new migration rather than an edit to 0001**, and the checksum guard
      -- is what made that the only option: editing an applied migration was
      -- caught on the next run with *migrations are forward-only*. The guard
      -- was right and the instinct — the schema has not shipped, so fold it in
      -- — was wrong for a reason worth writing down: *this* database had it
      -- applied, and every developer's and every environment's had too.
      --
      -- Null means absent, not empty. A person with no display name and a
      -- person called "" are the same person, and a NOT NULL DEFAULT '' makes
      -- the difference storable and therefore eventually stored.
      alter table ${USERS_TABLE} add column display_name text;
    `,
  },
];
