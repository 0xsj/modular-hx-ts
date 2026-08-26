/**
 * The queue table. **`work` infra.**
 *
 * nolint:tenant — this file is DDL, and DDL has no tenant to filter by.
 */

import { type MigrationSet } from '../postgres/index.js';

export const WORK_TABLE = 'work_jobs';
export const WORK_DEAD_TABLE = 'work_dead_letters';

export const workMigrations: MigrationSet = [
  {
    context: 'work',
    name: '0001_jobs',
    sql: `
      create table ${WORK_TABLE} (
        id              uuid        primary key,
        kind            text        not null,
        payload         jsonb       not null,

        -- The provenance of the request that asked for the work, carried so a
        -- record the worker writes ties back to it. A boundary hours wide is
        -- still a boundary.
        provenance      jsonb       not null,

        attempts        int         not null default 0,
        next_attempt_at timestamptz not null,

        -- A lease rather than a delete: a worker that dies releases the job by
        -- expiry rather than losing it.
        lease_until     timestamptz,
        lease_owner     text,

        last_error      text,
        enqueued_at     timestamptz not null
      );

      -- The claim reads by (next_attempt_at, lease) on every poll.
      create index ${WORK_TABLE}_claimable
        on ${WORK_TABLE} (next_attempt_at)
        where lease_until is null;

      create table ${WORK_DEAD_TABLE} (
        id          uuid        primary key,
        kind        text        not null,
        payload     jsonb       not null,
        provenance  jsonb       not null,
        attempts    int         not null,
        last_error  text        not null,
        dead_at     timestamptz not null
      );
    `,
  },
];
