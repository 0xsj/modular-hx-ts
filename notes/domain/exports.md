---
context: exports
---

# Exports — the response is not the artifact

## What

Ask for derived data, get a `202` and a `Location`. Poll it. Cancel it.
Download the result from a separate route while it lasts.

Four routes, one thin aggregate, and three substrate modules doing the work:
`work` runs it, `blob` holds it, `operations` is what a caller polls.

## Why

### The aggregate is thin on purpose

The state machine of long-running work lives in `operations` and is not this
context's to reinvent — that module exists precisely because v1 had it copied
three times. What **is** this context's: what may be exported, in what format,
and how long the result lives.

### The response is not the artifact

`202` returns a reference. The file is served by a **separate route with its own
authorization, checked at download time**.

A decision made when an export was created is a decision made before the
artifact existed and possibly hours before anybody reads it — the caller may
have been removed, the export may have expired, the ownership may have moved.
`readForDownload` asks all three *now*.

An expired artifact answers **404, not 410**: the difference between *gone* and
*never yours* is not the caller's to learn from a status code.

### Three writes, one commit

The export row, its operation and its queue entry. **Any two without the third
is a state nobody has code for**: an operation with no job says *running*
forever, a job with no export dereferences nothing, and an export with no
operation is work nobody can find.

That is the whole reason `work.enqueue` takes a writer, and this is its first
real consumer.

### One id for the export and its operation

Two would mean a caller polls one thing and downloads another, and every route
would need a lookup to relate them — a join that exists only because two ids
were minted where one would do.

### The TTL starts when the artifact is written

Not when it is requested. An export that took an hour to produce would otherwise
arrive already expired, and the caller would have no way to tell that from one
that was never written.

### Cancellation reaches the worker at a checkpoint

`runExport` asks `operation.abandoned` every 500 rows and once more before
settling. Nothing interrupts anything — `operations` is explicit that it cannot
— and the second check is what stops a cancellation that arrived *during* the
write from producing a `succeeded` the caller was told would not come.

## Gotchas

**The dataset reader is a port, and it is the seam again.** `S6` forbids
importing `identity`, so `exports` declares `Datasets` and the composition root
satisfies it — the same shape as `OrgRoles`. It is an **async generator**: a
reader that materialised every row would put the whole dataset in memory before
the streaming write ever started, which is the thing `blob`'s port shape exists
to avoid.

**It reads the same query the API serves**, so an export cannot show a row the
directory hides. That needed an `skipAuthorization` option on `listUsers`,
which is a bypass and is named like one: the worker runs with no request and no
subject, and a second policy in a second place is the one that drifts.

**`Dataset` has one value and it is not a placeholder.** `audit` sat in the union
briefly with nothing behind it, which would have shipped an endpoint that
accepted a request and produced an empty file — a silent wrong answer, worse
than a 400 saying the dataset is not exportable.

**CSV is RFC 4180, not `join(',')`.** The naive version works until a display
name has a comma in it, which is the first real dataset.

**A failure deletes the artifact and rethrows.** A half-written object nobody can
reach is a bill, and swallowing the error would make a permanently failing
export look completed to the queue and leave nothing to investigate.

**The sweep deletes bytes before forgetting the key.** A crash between them
leaves a row pointing at nothing, which the next sweep fixes and a download
reports as expired. The other order leaves an orphan the sweep can never find,
because the sweep walks rows.

**The transaction has two mechanisms and either is sufficient**, which a
breakage pass found: the transactor binds each adapter to `tx` *and* sets
`writer: tx`, and an adapter built with `tx` resolves `(writer) ?? db` to `tx`
either way. Deleting one leaves the integration test green. It is belt and
braces rather than a bug — and worth stating, because a future reader deleting
one half and seeing green will conclude the test is worthless rather than that
the other half caught them.

## Used in

- `tests/integration/exports/postgres.test.ts` — the three-writes-one-commit
  case, which the memory suite cannot fail
- `src/contexts/exports/index.test.ts` — including the first end-to-end exercise
  of `idempotency` over a request that does not complete synchronously

## Related

- [[work]] — the queue, and the transactional enqueue this is the first consumer
  of
- [[blob]] — where the artifact goes, under a key that encodes the tenant
- [[operations]] — the `202`/poll/cancel shape, built once at last
- [[idempotency]] — a claim held across a request that returns before the work
  finishes
- [[jobs]] — what will schedule the sweep
