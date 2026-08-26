/**
 * `orgs` tables. **`orgs` infra.**
 *
 * `MODULES.md` §3 namespaces migrations per context, so this context and
 * `identity` can both have an `0001`.
 *
 * **nolint:tenant — this file is DDL, and DDL has no tenant to filter by.**
 * `M3` reads every statement in a context's `infra/postgres/`, which is right:
 * the rule exists because a missing tenant filter returns other people's data
 * rather than an error, and nothing goes red. A `create table` cannot return
 * anybody's data.
 */

import { type MigrationSet } from '../../../../shared/postgres/index.js';

export const ORGS_TABLE = 'orgs_organizations';
export const MEMBERSHIPS_TABLE = 'orgs_memberships';
export const INVITATIONS_TABLE = 'orgs_invitations';

export const orgsMigrations: MigrationSet = [
  {
    context: 'orgs',
    name: '0001_organizations_and_memberships',
    sql: `
      create table ${ORGS_TABLE} (
        id          uuid        primary key,
        name        text        not null,

        -- Already lowercased and validated by the value object, so this index
        -- is a plain one. A functional index on lower(slug) would be a *second*
        -- normalization, and the two would eventually disagree about some slug
        -- neither was written for.
        slug        text        not null,

        -- **Null means active.** Archiving is not deleting: the memberships,
        -- the audit trail and the slug all stay, because releasing the slug
        -- would let somebody take the name of an organization whose records
        -- still exist.
        archived_at timestamptz,

        version     int         not null,
        created_at  timestamptz not null,
        updated_at  timestamptz not null
      );

      create unique index ${ORGS_TABLE}_slug on ${ORGS_TABLE} (slug);

      create table ${MEMBERSHIPS_TABLE} (
        id        uuid        primary key,
        org_id    uuid        not null references ${ORGS_TABLE}(id),

        -- **The identity user id, and deliberately not a foreign key.** S6
        -- makes the contexts islands, and a constraint across them is the same
        -- coupling written in SQL: it would make an identity migration an orgs
        -- migration, and a user delete a foreign-key error in another context.
        user_id   uuid        not null,

        role      text        not null,
        joined_at timestamptz not null,
        version   int         not null
      );

      -- One membership per person per organization. The uniqueness is the
      -- repository's, so a concurrent double-accept loses at the index rather
      -- than in a read the command performed.
      create unique index ${MEMBERSHIPS_TABLE}_member
        on ${MEMBERSHIPS_TABLE} (org_id, user_id);

      -- The roster read runs on every role change and every removal.
      create index ${MEMBERSHIPS_TABLE}_by_org on ${MEMBERSHIPS_TABLE} (org_id);
      -- And identity's org-roles port reads by user on every request.
      create index ${MEMBERSHIPS_TABLE}_by_user on ${MEMBERSHIPS_TABLE} (user_id);

      create table ${INVITATIONS_TABLE} (
        id                 uuid        primary key,
        org_id             uuid        not null references ${ORGS_TABLE}(id),
        email              text        not null,
        role               text        not null,

        -- **The fingerprint, never the secret.** A dump of this table yields
        -- nothing anybody can present.
        secret_fingerprint text        not null,
        tag                text        not null,
        invited_by         uuid        not null,
        issued_at          timestamptz not null,
        expires_at         timestamptz not null,
        consumed_at        timestamptz,
        revoked_at         timestamptz,
        version            int         not null
      );

      create unique index ${INVITATIONS_TABLE}_fingerprint
        on ${INVITATIONS_TABLE} (secret_fingerprint);
      create index ${INVITATIONS_TABLE}_pending
        on ${INVITATIONS_TABLE} (org_id)
        where consumed_at is null and revoked_at is null;
    `,
  },
];
