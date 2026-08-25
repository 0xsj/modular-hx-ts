/**
 * The shared adapter. **L4 edge, and the one that makes it a rate limit.**
 *
 * Four replicas each holding a private bucket admit four times the configured
 * rate. This is the adapter that stops that, and everything interesting in it
 * is in one statement.
 *
 * **Check-and-consume is atomic.** The refill, the decision and the write are
 * one `insert ... on conflict do update ... where`, so two concurrent requests
 * cannot both observe the last token. The same shape as `idempotency`'s claim,
 * reused rather than rediscovered — including the lesson that an empty result
 * means *something we cannot see*, not *nothing is there*.
 *
 * **On `M13`, and this is a real limitation rather than a shortcut.** Refill
 * must be measured monotonically. The memory adapter injects a monotonic clock
 * and satisfies that exactly. **PostgreSQL exposes no monotonic clock** — there
 * is no counterpart to `performance.now()` in SQL, and a per-process monotonic
 * reading is meaningless in shared state because two processes have two
 * unrelated origins.
 *
 * So this adapter measures against the database's own wall clock, which is at
 * least *one* clock rather than N, and the arithmetic in `bucket.ts` bounds
 * both directions of error: elapsed is floored at zero, so a backward step
 * refills nothing rather than draining; and the result is capped at capacity,
 * so a forward step grants one full bucket rather than an unbounded one. A
 * clock correction on the database host therefore costs at most one burst, and
 * never a stall.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { asAppError, type DB } from '../postgres/index.js';
import { type Decision, type Limit, decide, rate } from './bucket.js';
import { type Buckets } from './port.js';
import { BUCKETS_TABLE } from './schema.js';

interface Row {
  readonly tokens: number;
  readonly allowed: boolean;
}

/**
 * Refill, decide and write in one statement.
 *
 * `$1` key · `$2` capacity · `$3` tokens per millisecond · `$4` **the reading**.
 *
 * `$4` was `now()`, and `MODULES.md` §5 forbids it: the store must not consult
 * its own clock. The twin advances a fake clock and this advanced PostgreSQL's,
 * so the one contract suite `I2` requires could assert on refill in neither.
 *
 * The refill expression appears twice — once in `set`, once in `where` — and
 * that duplication is deliberate rather than tidied into a lateral join: the
 * `where` of an `on conflict do update` is evaluated against the **latest** row
 * version, and moving the arithmetic anywhere else would silently move it back
 * onto the statement's snapshot. That is precisely the distinction that cost
 * three of sixteen concurrent claimants in `idempotency`.
 */
const refill = `least($2::float8,
    ${BUCKETS_TABLE}.tokens
    + greatest(0, extract(epoch from ($4::timestamptz - ${BUCKETS_TABLE}.read_at)) * 1000)
      * $3::float8)`;

const TAKE = `
  with taken as (
    insert into ${BUCKETS_TABLE} (key, tokens, read_at)
    values ($1, $2::float8 - 1, $4::timestamptz)
    on conflict (key) do update
      set tokens  = ${refill} - 1,
          read_at = $4::timestamptz
      where ${refill} >= 1
    returning tokens, true as allowed
  )
  select tokens, allowed from taken
  union all
  select
    least($2::float8,
      b.tokens
      + greatest(0, extract(epoch from ($4::timestamptz - b.read_at)) * 1000) * $3::float8),
    false as allowed
    from ${BUCKETS_TABLE} b
   where b.key = $1 and not exists (select 1 from taken)
`;

export function postgresBuckets(db: DB): Buckets {
  return {
    async take(key: string, limit: Limit, at: Date): Promise<Decision> {
      let row: Row | undefined;
      try {
        row =
          (await db.queryRow<Row>(TAKE, [
            key,
            limit.limit,
            rate(limit),
            at.toISOString(),
          ])) ?? undefined;
      } catch (error) {
        // Surfaced with a `Kind` so the middleware can recognise a store
        // failure and degrade rather than guess from a driver error.
        throw asAppError(error, 'take a rate limit token');
      }

      // Neither branch returned: the insert conflicted with a row this
      // statement's snapshot cannot see, which means a concurrent request for
      // the same key committed while this one was waiting on it.
      //
      // **Admit it, and this is the opposite of `idempotency`'s answer to the
      // identical situation** — deliberately. This module's category is
      // availability, so ambiguity resolves toward serving; that module's is
      // data integrity, so ambiguity resolves toward refusing. One caller
      // getting one extra token in a race costs a rounding error on a
      // throttle. See `../../../RESILIENCE.md` §1.
      if (row === undefined) return decide(true, limit.limit - 1, limit);

      return decide(row.allowed, row.tokens, limit);
    },

    async purge(idleFor: Limit, at: Date): Promise<number> {
      try {
        // A full bucket is indistinguishable from an absent one, so this
        // changes no answer — it reclaims rows for keys nobody has used since
        // they refilled. Computed rather than assumed from `read_at` alone,
        // because a bucket that was empty needs a whole window to get there.
        return await db.exec(
          `delete from ${BUCKETS_TABLE}
            where extract(epoch from ($2::timestamptz - read_at)) * 1000 >= $1::float8`,
          [idleFor.window, at.toISOString()],
        );
      } catch (error) {
        throw asAppError(error, 'purge rate limit buckets');
      }
    },
  };
}
