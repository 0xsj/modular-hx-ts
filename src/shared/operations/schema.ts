/**
 * The operations table. nolint:tenant — DDL has no tenant to filter by.
 */

import { type MigrationSet } from '../postgres/index.js';

export const OPERATIONS_TABLE = 'operations';

export const operationsMigrations: MigrationSet = [
  {
    context: 'operations',
    name: '0001_operations',
    sql: `
      create table ${OPERATIONS_TABLE} (
        id          uuid        primary key,
        kind        text        not null,
        state       text        not null,

        -- Who asked. A poll compares against this, and the comparison is what
        -- makes an id useless to anybody else.
        owner_id    uuid        not null,
        tenant      text        not null,

        -- A reference, never the artifact. Whatever serves the href is a
        -- separate route with its own authorization, checked at download time.
        result      jsonb,
        error       text,

        started_at  timestamptz not null,
        finished_at timestamptz,
        version     int         not null
      );

      create index ${OPERATIONS_TABLE}_by_owner
        on ${OPERATIONS_TABLE} (tenant, owner_id, started_at desc);
    `,
  },
];
