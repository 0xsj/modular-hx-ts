---
module: operations
layer: L3
---

# Operations — 202, Location, poll, cancel

## What

A record of long-running work: `running`, then one of `succeeded`, `failed`,
`cancelled`. A `Location` to poll, a result that is a **reference**, and a
cancellation that is a state.

## Why

### The ×3 harvest, built once at last

v1 had this shape copied into three places, and the copies disagreed about the
one thing that matters: what happens after a terminal state. This is the first
time it exists once.

### A terminal state never moves

The rule the three copies disagreed about, and the reason a poll can promise
what conformance case 46 asks — *reports a terminal state exactly once*. A
worker that finishes after a cancellation, or that retries a job whose operation
already succeeded, must not overwrite what a caller has already read.

`succeed`, `fail` and `cancel` all go through one guard, and the guard throws
`Conflict`. Deleting it fails five cases.

### Cancellation is a state, not a kill

There is no way to stop a worker from here and there should not be: a cancelled
operation stops *being worked* and says so, and a worker mid-write finds out at
its next checkpoint — `operation.abandoned`, asked between units.

A module that promised to interrupt would be promising something no queue and no
filesystem can deliver. What it can promise is that nothing further is recorded,
and that is what `abandoned` plus the terminal guard buy.

**Cancelling twice is not an error.** A client that pressed the button twice is
a client. **Cancelling something that succeeded is refused** — the artifact
exists, and pretending it does not is worse than saying no.

### The result is a reference, never the artifact

`succeeded` carries an `href`. Whatever serves that href is a separate route
with its own authorization, **checked at download time rather than at
creation**. An operation that embedded bytes would be one whose poll response
grew without limit and whose authorization was decided hours before the read.

## Gotchas

**404, never 403, for an operation somebody may not see.** A 403 confirms it
exists and turns any id into an oracle for what other people are exporting —
conformance case 23's rule, applied to a resource that is not a user.

**The owner is on the record.** A poll compares against it, and the comparison
is what makes an id useless to anybody else.

**`index.ts` is a barrel and holds nothing.** The record lives in
`operation.ts`, because a class in the barrel made every adapter import the file
that re-exported them and the cruiser's `no-circular` caught it on the first
run — the same shape `httproute/statuses.ts` had.

**The memory adapter's methods are `async`.** A port method declared
`Promise<void>` that throws *synchronously* cannot be `.catch()`ed, and the
difference from the PostgreSQL adapter — async by construction — is invisible
until somebody writes `save(x).catch(...)` and the process dies instead of
recovering. `I2` did not catch it because no contract case used `.rejects` on
the twin.

## Example

```ts
const op = Operation.start(id, 'export', caller, tenant, clock.now());
await operations.create(op, tx);       // in the caller's transaction
return json(202, view(op), { location: locationOf(op.id) });
```

## Used in

- `src/shared/operations/index.test.ts` — the terminal-state rule, from four
  directions

## Related

- [[work]] — what actually runs while an operation says `running`
- [[blob]] — where the artifact an operation references lives
- [[httproute]] — the registry a `202` route is declared on
