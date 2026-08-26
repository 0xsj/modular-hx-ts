/**
 * The exports table. nolint:tenant — DDL has no tenant to filter by.
 */

import { type MigrationSet } from '../../../../shared/postgres/index.js';

export const EXPORTS_TABLE = 'exports_exports';

export const exportsMigrations: MigrationSet = [
  {
    context: 'exports',
    name: '0001_exports',
    sql: `
      create table ${EXPORTS_TABLE} (
        id           uuid        primary key,

        -- The same id as the operation a caller polls. One id rather than two,
        -- so no route needs a join that exists only because two were minted.
        operation_id uuid        not null,

        dataset      text        not null,
        format       text        not null,
        requested_by uuid        not null,
        tenant       text        not null,

        -- Absent until the work finishes. The key encodes the tenant, so a
        -- row cannot name another tenant's object however it was written.
        blob_key     text,
        rows         bigint,
        bytes        bigint,

        -- Measured from when the artifact was WRITTEN. A TTL from the request
        -- would expire an export that took an hour before anybody read it.
        expires_at   timestamptz,

        requested_at timestamptz not null,
        version      int         not null
      );

      create unique index ${EXPORTS_TABLE}_operation
        on ${EXPORTS_TABLE} (operation_id);

      -- What the sweep walks: artifacts with a key and a past expiry.
      create index ${EXPORTS_TABLE}_expiring
        on ${EXPORTS_TABLE} (expires_at)
        where blob_key is not null;
    `,
  },
];
