/**
 * Fleet-wide flags, TTL-cached. **The `postgres` provider.**
 *
 * **It serves stale and refreshes in the background.** A flag check is on the
 * hot path and must never wait on a database — a request that blocks on a flag
 * lookup has made the flag *worse than a restart*, which is the one thing this
 * module exists to be better than.
 *
 * So `get` is synchronous and always answers from the cache. When the TTL has
 * passed it kicks off a refresh and returns the old value anyway; the next
 * caller gets the new one.
 *
 * **The consequence is worth stating, because it shapes every test:** the first
 * read after a write is *expected to be stale*. A test that writes a flag and
 * immediately asserts it must **retry rather than sleep** — sleeping picks a
 * number and hopes, retrying asserts the thing that is actually promised, which
 * is *eventually, within the TTL*.
 *
 * See `notes/patterns/flags.md`.
 */

import { type Clock, type Millis, seconds, since } from '../clock/index.js';
import { type DB, type MigrationSet } from '../postgres/index.js';
import { validate, type Flag, type Rule } from './rule.js';
import { type Source } from './port.js';

export const FLAGS_TABLE = 'feature_flags';

export const flagMigrations: MigrationSet = [
  {
    context: 'flags',
    name: '0001_flags',
    sql: `
      create table ${FLAGS_TABLE} (
        key         text        primary key,
        fallback    text        not null,
        rules       jsonb       not null default '[]'::jsonb,
        description text,
        updated_at  timestamptz not null default now()
      );
    `,
  },
];

export interface PostgresOptions {
  readonly db: DB;
  readonly clock: Clock;
  /** How stale a value may be before a refresh is started. */
  readonly ttl?: Millis;
  /** Reported when a refresh fails. The last good values keep serving. */
  readonly onError?: (error: unknown) => void;
}

interface Row {
  readonly key: string;
  readonly fallback: string;
  readonly rules: readonly Rule[];
  readonly description: string | null;
}

export interface PostgresSource extends Source {
  /** Required here, though optional on `Source` — `static` has nothing to do. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Force a refresh and wait for it. For a test, and for `doctor`. */
  refresh(): Promise<void>;
  /** How stale the cache is, in milliseconds. */
  age(): number;
}

export function postgresSource(options: PostgresOptions): PostgresSource {
  const { db, clock } = options;
  const ttl = options.ttl ?? seconds(30);

  let cache = new Map<string, Flag>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    const rows = await db.query<Row>(
      `select key, fallback, rules, description from ${FLAGS_TABLE}`,
    );

    const flags = rows.map((row) => ({
      key: row.key,
      fallback: row.fallback,
      rules: row.rules,
      ...(row.description === null ? {} : { description: row.description }),
    }));

    // A malformed row must not take the whole set down: the valid ones keep
    // serving and the problem is reported. `validate` reports every problem at
    // once, so the log names all of them rather than the first.
    const checked = validate(flags);
    if (!checked.ok) {
      options.onError?.(checked.error);
      return;
    }

    cache = new Map(flags.map((f) => [f.key, f]));
    loadedAt = clock.elapsed();
  };

  /** Start a refresh if one is not already running. Never awaited by `get`. */
  const refreshInBackground = (): void => {
    if (inFlight !== undefined) return;
    inFlight = load()
      .catch((error: unknown) => {
        // The last good values keep serving. A database blip must not turn
        // every flag off.
        options.onError?.(error);
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  return {
    get(key) {
      if (since(clock, loadedAt) >= ttl) refreshInBackground();
      // **Stale on purpose.** The old value now beats the right value later.
      return cache.get(key);
    },

    all() {
      if (since(clock, loadedAt) >= ttl) refreshInBackground();
      return [...cache.values()];
    },

    async start() {
      // The one blocking load, at boot, so the first request is not served
      // from an empty cache.
      await load();
    },

    async stop() {
      await inFlight;
    },

    async refresh() {
      await load();
    },

    age: () => since(clock, loadedAt),
  };
}
