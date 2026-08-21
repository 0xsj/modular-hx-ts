---
module: pagination
layer: L0
---

# Pagination

## What

Keyset cursors. A cursor carries the sort-key values of the last row of the
previous page; the next page is `WHERE (key) > (cursor) ORDER BY key LIMIT n`.
`encodeCursor`/`decodeCursor` make it opaque and URL-safe, `resolveLimit` clamps
a requested page size, and `paginate` turns an over-fetch of `limit + 1` rows
into a page plus a cursor.

## Why

### `OFFSET` is wrong twice

**It is slow.** `OFFSET 100000` makes the database produce and discard a hundred
thousand rows before returning anything. Cost grows with the page number, so the
deepest pages — the ones an export or a crawler hits — are the most expensive.
Keyset is an index seek: O(log n) for every page, including the last.

**It is incorrect.** This is the half people forget. `OFFSET` counts positions
in a result set that is being written to concurrently. Insert a row before the
offset between two page requests and everything shifts down: the reader **skips
a row**. Delete one and the reader **sees a row twice**. Nobody notices, because
the symptom is a missing record nobody knew to look for — and it is worst
exactly where it matters, in the batch job walking every row.

A cursor names a *position in the data*, not a count of rows, so concurrent
writes cannot shift it.

### The cursor carries its ordering

`users.created_at.desc` is encoded in the payload. The same values under a
different sort mean a different position, so replaying one listing's cursor
against another would silently return the wrong page. Cheap to check, and the
failure it prevents is invisible.

### No total count

Deliberately not offered. It costs a scan of the whole predicate on every page,
it is stale before it renders, and keyset has no page numbers for it to feed.
When a product genuinely needs "about 2,000 results", that is an estimate from
the query planner, not a `COUNT(*)`.

**Rejected: page numbers.** They require `OFFSET`, and they promise a stable
mapping from number to rows that no concurrently-written table can keep.

**Rejected: signing cursors.** Tamper-proofing needs a keyring, which is L3, and
this is L0. A cursor is opaque, not authenticated — see the gotcha.

## Example

```sql
-- The sort key must be a TOTAL order, hence the id tiebreak.
SELECT * FROM users
WHERE  tenant_id = $1
  AND  (created_at, id) < ($2, $3)   -- the cursor, for a DESC listing
ORDER  BY created_at DESC, id DESC
LIMIT  $4;                            -- limit + 1
```

```ts
const limit = resolveLimit(query.limit);
const rows = await repo.list(tenant, cursorPosition, limit + 1);

return paginate(rows, limit, 'users.created_at.desc', (row) => [
  row.createdAt,
  row.id,
]);
```

## Gotchas

- **The sort key must be a total order.** `created_at` alone is not: two rows
  written in the same millisecond compare equal, and the page boundary either
  skips or repeats them. Always append a unique tiebreak — `(created_at, id)`.
  A time-ordered [[id]] makes the tiebreak meaningful rather than arbitrary.
- **A cursor is opaque, not authenticated.** Anyone can decode and craft one, so
  it may hold a position and nothing else. Never put a tenant id, a filter, or
  anything authorization reads into it: the query must re-derive those from the
  request every time.
- **`NULL`s in the sort key break comparison.** `NULL < anything` is `NULL`, not
  `true`, so a nullable sort column silently drops rows at the boundary. Sort on
  a `NOT NULL` column, or use `NULLS LAST` and a coalesced key consistently in
  both the `ORDER BY` and the `WHERE`.
- **Changing the sort invalidates every outstanding cursor** — which is correct,
  and why the ordering is in the payload. Bump the ordering name whenever the
  sort changes, or old cursors will decode and quietly mean something else.
- **Over-fetch by exactly one.** Fetching `limit` rows cannot distinguish
  "exactly full" from "there is more", and guessing wrong shows an empty final
  page to every client.
- **`resolveLimit` clamps, it does not refuse.** Invariant I9: a resource
  control fails closed on the resource and open on the request. `?limit=10000`
  is usually a client guessing, and a 400 teaches nothing the cap has not
  already handled.

## Used in

- `src/shared/pagination/index.ts`
- `src/shared/pagination/index.test.ts`

This list grows to every listing endpoint and every export that walks a table.

## Related

[[digest]] — the cursor body is canonical JSON, so the same position always
encodes to the same cursor. [[brand]] — what makes `Cursor` a distinct type.
[[id]] — a time-ordered id makes `(created_at, id)` a natural total order.
[[assert]] — where a contradictory limit policy goes. [[errors]] and [[result]]
— how an unreadable cursor is refused.
