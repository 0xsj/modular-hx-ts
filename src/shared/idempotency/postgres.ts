/**
 * The PostgreSQL adapter. **L4 edge, and the one that survives a crash.**
 *
 * Everything interesting is in `claim`, and it is interesting for one reason:
 * **the claim must be atomic.** Read-then-write means two simultaneous requests
 * with the same key both read "absent", both claim it, and the write the client
 * asked to have protected happens twice — which is the entire failure this
 * module exists to prevent, reintroduced by the module itself.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { type Millis, hours, seconds } from '../clock/index.js';
import { type Digest } from '../digest/index.js';
import { asAppError, type DB } from '../postgres/index.js';
import { type ScopedKey } from './key.js';
import {
  type Claim,
  type RecordOptions,
  type Records,
  type StoredResponse,
} from './port.js';
import { RECORDS_TABLE } from './schema.js';

interface Row {
  readonly claimed: boolean;
  readonly fingerprint: string;
  readonly status: number | null;
  readonly headers: Record<string, string> | null;
  readonly body: string | null;
  readonly consumed: boolean;
}

/**
 * Finished, either way: a stored response, or a key spent past the cap.
 *
 * Takes the qualifier because the upsert's `where` needs the table name and the
 * purge does not — and an unqualified `consumed` inside `on conflict do update`
 * would read `excluded.consumed`, which is exactly the wrong row.
 */
const finished = (qualifier = ''): string => {
  const q = qualifier === '' ? '' : `${qualifier}.`;
  return `(${q}status is not null or ${q}consumed)`;
};

/**
 * Claim, or read what stopped you — **in one statement**.
 *
 * The insert takes the key when nobody holds it. `on conflict do update ...
 * where` takes it back when the existing row is dead: an in-flight claim past
 * its lease, or a completed response past its TTL. When neither applies the
 * update matches nothing and returns nothing, and the second branch reads the
 * row that blocked it.
 *
 * **The `union all` branch is a best-effort read, not the decision.** A
 * data-modifying CTE runs against the snapshot taken when the statement began,
 * while `on conflict` re-checks against the *latest* row version — so under
 * real contention the insert correctly finds a conflict and the select
 * correctly finds nothing, because the row that blocked it was committed by
 * another transaction after this statement's snapshot was taken.
 *
 * Sixteen concurrent claims against a real database produced **three** winners
 * before this was understood, by way of an "it returned nothing, so nobody
 * holds it" branch. Nothing in the in-process suite could have found it: there
 * the claim is atomic because JavaScript runs it to completion, and there is
 * only ever one snapshot. Empty now means *something blocked us that we cannot
 * see*, and it is resolved by a second read on a fresh snapshot — never by
 * assuming the key is free.
 */
const CLAIM = `
  with attempt as (
    insert into ${RECORDS_TABLE}
      (tenant, principal, key, fingerprint, lease_until)
    values ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)
    on conflict (tenant, principal, key) do update
      set fingerprint = excluded.fingerprint,
          status      = null,
          headers     = null,
          body        = null,
          consumed    = false,
          lease_until = excluded.lease_until,
          expires_at  = null,
          claimed_at  = now()
      where (not ${finished(RECORDS_TABLE)}
             and ${RECORDS_TABLE}.lease_until <= now())
         or (${finished(RECORDS_TABLE)}
             and ${RECORDS_TABLE}.expires_at <= now())
    returning true as claimed, fingerprint, status, headers, body, consumed
  )
  select * from attempt
  union all
  select false as claimed, fingerprint, status, headers, body, consumed
    from ${RECORDS_TABLE}
   where tenant = $1 and principal = $2 and key = $3
     and not exists (select 1 from attempt)
`;

/** The follow-up read. A fresh snapshot, and the reason it is a second call. */
const LOOKUP = `
  select false as claimed, fingerprint, status, headers, body, consumed
    from ${RECORDS_TABLE}
   where tenant = $1 and principal = $2 and key = $3
`;

export function postgresRecords(db: DB, options: RecordOptions = {}): Records {
  const ttl: Millis = options.ttl ?? hours(24);
  const leaseFor: Millis = options.leaseFor ?? seconds(30);

  const scope = (key: ScopedKey): readonly unknown[] => [
    key.tenant,
    key.principal,
    key.key,
  ];

  return {
    async claim(key: ScopedKey, fingerprint: Digest): Promise<Claim> {
      let row: Row | undefined;
      try {
        row =
          (await db.queryRow<Row>(CLAIM, [
            ...scope(key),
            fingerprint,
            String(leaseFor),
          ])) ?? undefined;

        // The insert conflicted with a row this statement's snapshot could not
        // see. A second statement gets a fresh snapshot under READ COMMITTED,
        // which is enough to say *why* rather than guess.
        row ??= (await db.queryRow<Row>(LOOKUP, scope(key))) ?? undefined;
      } catch (error) {
        // Surfaced with a `Kind`, so the middleware can fail closed on it
        // rather than guessing from a driver error.
        throw asAppError(error, 'claim an idempotency key');
      }

      // Still nothing, so a concurrent `release` took the row between the two
      // reads. **Fail closed**: the only thing known is that something else is
      // acting on this key right now, and 409 sends the client back in a
      // moment. Reading it as "claimed" is the fail-open default this module
      // exists to refuse, and it is what let three of sixteen concurrent
      // claimants through.
      //
      // **No test reaches this line, and that is stated rather than hidden**:
      // it needs another session to delete the row inside the window between
      // two statements of this function, which nothing outside the function can
      // schedule. Deleting the branch would be worse than leaving it unproven,
      // because the alternative to a defensive 409 is a silent second
      // execution.
      if (row === undefined) return { outcome: 'in-flight' };
      if (row.claimed) return { outcome: 'claimed' };

      if (row.fingerprint !== fingerprint) return { outcome: 'mismatch' };
      if (row.consumed) return { outcome: 'consumed' };
      if (row.status === null) return { outcome: 'in-flight' };

      return {
        outcome: 'replay',
        response: {
          status: row.status,
          headers: row.headers ?? {},
          body: row.body ?? '',
        },
      };
    },

    async complete(key: ScopedKey, response: StoredResponse): Promise<void> {
      try {
        await db.exec(
          `update ${RECORDS_TABLE}
              set status      = $4,
                  headers     = $5,
                  body        = $6,
                  lease_until = null,
                  expires_at  = now() + ($7 || ' milliseconds')::interval
            where tenant = $1 and principal = $2 and key = $3`,
          [
            ...scope(key),
            response.status,
            JSON.stringify(response.headers),
            response.body,
            String(ttl),
          ],
        );
      } catch (error) {
        throw asAppError(error, 'store an idempotent response');
      }
    },

    async consume(key: ScopedKey): Promise<void> {
      try {
        // Same shape as `complete` — the lease ends, the window opens — with
        // nothing to serve from it. Spending the key is the point.
        await db.exec(
          `update ${RECORDS_TABLE}
              set consumed    = true,
                  lease_until = null,
                  expires_at  = now() + ($4 || ' milliseconds')::interval
            where tenant = $1 and principal = $2 and key = $3`,
          [...scope(key), String(ttl)],
        );
      } catch (error) {
        throw asAppError(error, 'consume an idempotency key');
      }
    },

    async release(key: ScopedKey): Promise<void> {
      try {
        await db.exec(
          `delete from ${RECORDS_TABLE}
            where tenant = $1 and principal = $2 and key = $3`,
          [...scope(key)],
        );
      } catch (error) {
        throw asAppError(error, 'release an idempotency key');
      }
    },

    async purge(): Promise<number> {
      try {
        // Completed records only. An in-flight row past its lease is
        // reclaimable rather than garbage, and deleting it here would hide a
        // claimant that is merely slow from anyone reading the table.
        return await db.exec(
          `delete from ${RECORDS_TABLE}
            where ${finished()} and expires_at <= now()`,
        );
      } catch (error) {
        throw asAppError(error, 'purge idempotency records');
      }
    },
  };
}
