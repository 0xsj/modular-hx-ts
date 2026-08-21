/**
 * Keyset pagination. **L0 kernel** — pure, no I/O, no process state.
 *
 * A cursor carries the sort-key values of the last row of the previous page, so
 * the next page is `WHERE (key) > (cursor) ORDER BY key LIMIT n` — an index
 * seek, O(log n), whatever the page number.
 *
 * `OFFSET` is the alternative and it is wrong twice over. It is O(offset):
 * page 5,000 makes the database walk and discard 100,000 rows. And it is
 * **incorrect under concurrent writes** — a row inserted before the offset
 * shifts everything down, so the reader silently skips a row; a deletion
 * duplicates one. Nobody notices, because the symptom is a missing record
 * nobody knew to look for.
 *
 * See `notes/techniques/pagination.md`.
 */

import { invariant } from '../assert/index.js';
import { type Brand, unsafeBrand } from '../brand/index.js';
import { canonicalize, type JsonValue } from '../digest/index.js';
import { invalid } from '../errors/index.js';
import { err, isErr, ok, type Result } from '../result/index.js';

/** An opaque, URL-safe position. */
export type Cursor = Brand<string, 'Cursor'>;

export interface LimitPolicy {
  readonly fallback: number;
  readonly max: number;
}

export const DEFAULT_LIMITS: LimitPolicy = { fallback: 20, max: 100 };

/**
 * Clamp a requested page size.
 *
 * Clamped rather than refused, deliberately. `?limit=10000` is far more often a
 * client guessing than an attack, and a 400 teaches nothing; the cap is the
 * protection and it works either way. Invariant I9 — this is a resource
 * control, so it fails closed on the resource and open on the request.
 */
export function resolveLimit(
  requested: number | undefined,
  policy: LimitPolicy = DEFAULT_LIMITS,
): number {
  invariant(policy.max >= 1, 'max limit is at least 1');
  invariant(
    policy.fallback >= 1 && policy.fallback <= policy.max,
    'fallback limit is within the maximum',
  );

  if (requested === undefined || !Number.isFinite(requested)) {
    return policy.fallback;
  }

  return Math.min(policy.max, Math.max(1, Math.floor(requested)));
}

interface CursorPayload {
  /** The ordering this cursor belongs to. */
  readonly o: string;
  /** The sort-key values of the last row of the previous page. */
  readonly p: JsonValue;
}

/**
 * Encode a position.
 *
 * `order` names the ordering the cursor belongs to — `users.created_at.desc`.
 * Carrying it means a cursor from one listing cannot be replayed against
 * another, where the same values would mean something else entirely.
 *
 * The body is canonical JSON, so the same position always encodes to the same
 * cursor, which makes the encoding testable and cacheable.
 */
export function encodeCursor(
  order: string,
  position: JsonValue,
): Result<Cursor> {
  const payload: CursorPayload = { o: order, p: position };
  const canonical = canonicalize(payload);
  if (isErr(canonical)) return err(canonical.error);

  const encoded = Buffer.from(canonical.value, 'utf8').toString('base64url');
  return ok(unsafeBrand<string, 'Cursor'>(encoded));
}

/** Decode a cursor, refusing one that belongs to a different ordering. */
export function decodeCursor(order: string, cursor: Cursor): Result<JsonValue> {
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as unknown;
  } catch {
    // Never echo the cursor: it is caller-supplied, and an error message is a
    // log line.
    return err(invalid('cursor is not readable'));
  }

  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('o' in payload) ||
    !('p' in payload)
  ) {
    return err(invalid('cursor is not readable'));
  }

  const { o, p } = payload as { o: unknown; p: JsonValue };
  if (o !== order) {
    return err(invalid('cursor is for a different ordering'));
  }

  return ok(p);
}

export interface Page<T> {
  readonly items: readonly T[];
  /** Absent when this is the last page. */
  readonly next?: Cursor;
}

/**
 * Turn an over-fetch into a page.
 *
 * The caller asks the store for `limit + 1` rows. If it gets them, there is
 * another page and the extra row is discarded — which is how "is there more"
 * is answered **without a second `COUNT(*)` query** over the same predicate.
 *
 * A total count is deliberately not offered. It costs a full scan on every
 * page, it is stale by the time it is rendered, and keyset pagination has no
 * page numbers for it to feed.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  order: string,
  positionOf: (row: T) => JsonValue,
): Result<Page<T>> {
  invariant(
    Number.isInteger(limit) && limit >= 1,
    'limit is a positive integer',
  );

  if (rows.length <= limit) return ok({ items: rows });

  const items = rows.slice(0, limit);
  const last = items.at(-1);
  invariant(last !== undefined, 'a full page has a last row');

  const next = encodeCursor(order, positionOf(last));
  return isErr(next) ? err(next.error) : ok({ items, next: next.value });
}
