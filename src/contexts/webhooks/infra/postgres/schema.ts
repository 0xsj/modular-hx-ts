/**
 * The webhooks tables. nolint:tenant — DDL has no tenant to filter by.
 */

import { type MigrationSet } from '../../../../shared/postgres/index.js';

export const ENDPOINTS_TABLE = 'webhooks_endpoints';
export const DELIVERIES_TABLE = 'webhooks_deliveries';

export const webhooksMigrations: MigrationSet = [
  {
    context: 'webhooks',
    name: '0001_endpoints_and_deliveries',
    sql: `
      create table ${ENDPOINTS_TABLE} (
        id                  uuid        primary key,
        owner_id            uuid        not null,
        url                 text        not null,

        -- **The subscription list, as an array, and the index below is why.**
        -- A join table would be more normal and would make "wanting" a join
        -- plus a group-by on every published event. This is read far more often
        -- than it is written — once per event per installation — and "&&"
        -- against a GIN index answers it with one predicate.
        events              text[]      not null,

        -- **A fingerprint, never the secret.** Signing happens where the key
        -- lives; what this table holds is enough to tell two secrets apart and
        -- useless for forging one.
        secret_fingerprint  text        not null,

        state               text        not null,
        disabled_because    text,

        -- Consecutive, and reset by one success — see the aggregate.
        consecutive_failures int        not null default 0,

        created_at          timestamptz not null,
        updated_at          timestamptz not null,
        version             int         not null
      );

      create index ${ENDPOINTS_TABLE}_owner
        on ${ENDPOINTS_TABLE} (owner_id, created_at, id);

      -- **Only enabled endpoints are ever fanned out to**, so the index that
      -- answers the fan-out carries the predicate rather than filtering after.
      create index ${ENDPOINTS_TABLE}_events
        on ${ENDPOINTS_TABLE} using gin (events)
        where state = 'enabled';

      create table ${DELIVERIES_TABLE} (
        id                  uuid        primary key,
        endpoint_id         uuid        not null
                              references ${ENDPOINTS_TABLE} (id) on delete cascade,

        event_id            uuid        not null,
        event_name          text        not null,

        -- **The exact bytes that were signed.** A retry must send them again
        -- byte for byte, so re-rendering at attempt time would invalidate every
        -- signature in flight the next time the renderer changed.
        payload             text        not null,

        state               text        not null,

        -- The attempt history, newest last, capped by the aggregate.
        attempts            jsonb       not null default '[]'::jsonb,
        total_attempts      int         not null default 0,
        attempts_this_round int         not null default 0,

        next_attempt_at     timestamptz,
        created_at          timestamptz not null,
        updated_at          timestamptz not null,
        version             int         not null
      );

      -- The delivery log for one endpoint, newest first, keyset-paged.
      create index ${DELIVERIES_TABLE}_by_endpoint
        on ${DELIVERIES_TABLE} (endpoint_id, created_at desc, id desc);

      -- **One delivery per event per endpoint.** The fan-out is driven by an
      -- at-least-once bus, so the same envelope can arrive twice; without this
      -- a redelivered event sends the webhook twice and the receiver has no way
      -- to tell, because both would carry different delivery ids.
      create unique index ${DELIVERIES_TABLE}_once
        on ${DELIVERIES_TABLE} (endpoint_id, event_id);
    `,
  },
];
