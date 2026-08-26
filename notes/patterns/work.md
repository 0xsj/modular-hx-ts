---
module: work
layer: L2
---

# Work — enqueue in your transaction

## What

A durable queue. `enqueue` takes the caller's transaction handle; `claim` leases
a batch; `complete` removes; `fail` retries with backoff or dead-letters. A
`worker` loop drains it.

Two adapters, one contract suite, and **the reading is a parameter** — `at` on
`enqueue`, `claim` and `fail`.

## Why

### The first clause is the design

> enqueue **in your transaction**, leased worker, retry, dead-letter

The row a job is about and the queue entry that will process it commit together
or neither does. The outbox lesson applied to work rather than events, and the
same failure it prevents: an export row that rolled back leaves a job whose
target does not exist, and a job that rolled back leaves an export that says
*running* forever.

Which is why `enqueue` takes a writer. Defaulting to the pool would silently
turn every enqueue into a second transaction and hand back exactly the
dual-write problem the port removes — the same signature `events` has, for the
same reason.

### The contract suite did not test it, and that is the finding

**The clause that is the design had no case.** Every other case in the suite
enqueues outside a transaction and never notices the writer is ignored — which
is precisely the failure the collection had already found twice in other
repositories, arriving here in the same shape and caught only because a
breakage pass was asked for.

Deleting `?? db` from `enqueue` — making it write on the pool — now fails two
cases. Before, it failed none.

The memory twin supplies **no** `rollBack`, honestly: it has nothing to make
atomic and loses everything on restart, which is what `STORAGE=memory` means.
Supplying a rollback that did nothing would make the case pass in the twin and
prove nothing, which is the shape of the bug the case exists for.

### The reading is a parameter, for the reason `ratelimit` learned

An adapter that consults its own clock — `now()` in SQL, `Date.now()` in a map —
cannot be driven by the suite that proves it agrees with its twin. The cases
about leases expiring and backoff elapsing would be asserted against a fake
instant in one and a real wait in the other, which makes them not the same test.

`ratelimit` found this the expensive way. Applying it here cost one signature
change and removed every `sleep` from the integration suite.

### A lease, not a delete

A worker that dies mid-job releases it by expiry rather than losing it. That is
the same choice the outbox makes and for the same reason: at-least-once is a
property you buy by making a crash indistinguishable from a slow worker.

**The lease predicate is the correctness mechanism; `for update skip locked` is
the latency one.** Without the predicate, two workers claim the same job.
Without `skip locked`, the second blocks and then finds it leased — the same
answer, more slowly. Stated separately because crediting the wrong one is how a
break stops being detectable, which is exactly what happened in `events`.

### Dead-lettered, never dropped

A job nobody can run is evidence, and deleting it deletes the only record that
the work was ever asked for.

## Gotchas

**The counter moves on the claim, not on the failure.** A job claimed and then
lost to a crash has still been attempted, and a counter that only moved on an
explicit failure would retry it forever.

**Every job runs inside the provenance that enqueued it.** `PROVENANCE.md`'s
carriage rule across a boundary that is hours wide rather than a function call —
a record the worker writes ties back to the request that asked for the work.

**A job whose provenance cannot be read is skipped, not retried.** Unreadable
bytes do not become readable, and a job with no provenance writes records nobody
can correlate.

**The contract's counts are deltas.** The twin gets a fresh store per subject
and a real database does not; a case asserting `pending() === 0` passes in memory
and fails against PostgreSQL for a reason that has nothing to do with what it
tests.

**The worker loop is a separate thing from the queue.** A queue with a loop
welded on cannot be enqueued into by a process that does no work, which is most
of them — an API replica enqueues and a worker replica drains, and both use one
port.

## Example

```ts
await db.withinTx(async (tx) => {
  await exports.create(row, tx);            // the thing
  await queue.enqueue('export', { id }, provenance, clock.now(), tx);  // and its job
});
```

## Used in

- `tests/integration/work/postgres.test.ts` — where the transactional clause is
  the only place it can fail

## Related

- [[events]] — the outbox, which is the same rule for events rather than work
- [[jobs]] — scheduled work; this is requested work, and the two are different
  questions
- [[postgres]] — supplies the transaction handle the whole port is shaped around
- [[operations]] — what a caller polls while a job runs
