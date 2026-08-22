/**
 * The outbox table. **L2 substrate.**
 *
 * Namespaced `events`, not a context: the outbox is infrastructure every
 * context publishes through, and rule `M7` only requires that no two contexts
 * *share* a namespace.
 *
 * **Two clocks, deliberately apart.** `next_attempt_at` is **backoff** — when
 * this row becomes eligible again. `lease_until` is **ownership** — how long
 * the relay that claimed it may hold it. Collapsing them into one column is the
 * bug that makes a slow consumer look like a dead one: a long-running dispatch
 * would extend the retry delay, or a backoff would look like an expired lease
 * and hand the row to a second relay while the first is still working.
 *
 * See `notes/patterns/events.md`.
 */

import { type MigrationSet } from '../../postgres/index.js';

export const OUTBOX_TABLE = 'event_outbox';
export const DEAD_LETTER_TABLE = 'event_dead_letters';
export const HANDLED_TABLE = 'event_handled';

export const outboxMigrations: MigrationSet = [
  {
    context: 'events',
    name: '0001_outbox',
    sql: `
      create table ${OUTBOX_TABLE} (
        id              uuid        primary key,
        name            text        not null,
        occurred_at     timestamptz not null,
        envelope        jsonb       not null,

        attempts        int         not null default 0,
        -- Backoff: when this row is eligible again.
        next_attempt_at timestamptz not null default now(),
        -- Ownership: how long the claiming relay may hold it. A different
        -- question from the one above, which is why it is a different column.
        lease_until     timestamptz,
        lease_owner     text,

        created_at      timestamptz not null default now()
      );

      -- The relay's only query: eligible rows, oldest first.
      --
      -- Not a partial index. The obvious predicate is
      --   where lease_until is null or lease_until < now()
      -- and PostgreSQL refuses it: now() is STABLE rather than IMMUTABLE, so it
      -- cannot appear in an index predicate -- the index would have to be
      -- rebuilt every time the clock moved. SQLSTATE 42P17, caught the first
      -- time this migration ran against a real database, and by nothing before.
      create index ${OUTBOX_TABLE}_claimable
        on ${OUTBOX_TABLE} (next_attempt_at, occurred_at, lease_until);

      create table ${DEAD_LETTER_TABLE} (
        id           uuid        primary key,
        name         text        not null,
        envelope     jsonb       not null,
        attempts     int         not null,
        last_error   text        not null,
        dead_at      timestamptz not null default now()
      );

      -- At-least-once means a subscriber sees duplicates. This is where it
      -- proves it already handled one. Keyed by (subscriber, event), because
      -- two subscribers must each get their own delivery.
      create table ${HANDLED_TABLE} (
        subscriber  text        not null,
        event_id    uuid        not null,
        handled_at  timestamptz not null default now(),
        primary key (subscriber, event_id)
      );
    `,
  },
];
