---
module: lock
layer: L2
---

# Lock

## What

A named distributed mutex behind a port. Two adapters: `memory` for
`STORAGE=memory`, and **session-scoped PostgreSQL advisory locks** otherwise.

```
tryAcquire(name) -> Lease | undefined     never waits
withLock(name, fn) -> T | undefined       undefined = somebody else has it
releaseAll()                              what lifecycle calls on the way down
```

`lock` has no consumer without `jobs`, and `jobs` cannot run a fleet-wide
singleton without `lock`. They are one unit of work, and neither is ticked until
`Singleton` is green against a real database.

## Why

### Advisory locks, for one property above all others

**A crashed holder releases automatically.** The lock lives on the connection,
so a `SIGKILL`, an OOM or a severed network takes the backend with it and the
lock is free. Nothing sweeps, nothing expires, nothing has to notice.

That is the property that makes them right here. A fleet-wide singleton held by
an instance that has died is a job the fleet stops running entirely, and every
alternative has a window where exactly that happens.

**Rejected: a row in a table with a TTL.** It needs a sweeper; the TTL is a
guess about how long a healthy holder may pause; and a holder that dies keeps
its lock until the TTL expires — which is the window advisory locks do not have.
It also cannot distinguish "paused" from "gone", so the TTL is either too short
(two holders) or too long (no holder).

**Rejected: Redis.** `../INFRASTRUCTURE.md` §4 has Redis backing `cache` and
`ratelimit` only, and §3 rule 7 — a service nothing tests against is dead
weight. Postgres is already required and already running.

### Session-scoped, not transaction-scoped

`pg_try_advisory_lock` holds until released or the session ends.
`pg_try_advisory_xact_lock` releases at the end of the **transaction**, which
for a job that runs for a minute means the lock is gone long before the work is.

The migrator wants the transaction-scoped one for the same reason from the
opposite end: it *wants* the lock to disappear when its transaction does.

The consequence is the part that is easy to get wrong: **every lease holds its
own connection for its whole life.** Taking a lock on a pooled connection and
returning the connection leaves the lock held by whoever borrows it next, and
releasing from a *different* pooled connection is a silent no-op — Postgres
warns and returns `false` rather than erroring.

That requirement is why `postgres` grew a `Session`: `lock` needs a connection
it owns, and naming a `PoolClient` would have meant importing `pg`, which rule
`S10` forbids. The rule pushed the concept into the right module.

### Keys are hashed, and the hash is documented

An advisory lock key is a **signed 64-bit integer**, so every string name is
hashed down to one — and that integer space is shared across the whole database.
Two subsystems that collide block each other with no error, no log line, and no
way to tell from either side.

```
key(namespace, name) = int64(first 8 bytes of sha256(namespace + ":" + name))
```

The namespace is mandatory and part of the hashed bytes, so `jobs:purge` and
`leases:purge` cannot land on the same integer. Signed, because that is what
`pg_advisory_lock(bigint)` takes; the top bit is not masked, which would halve
the space for nothing and be a second thing to keep in step across languages.

### Never waits

`tryAcquire` returns `undefined` rather than queueing. A lock that queues turns a
contended period into a pile of instances each holding a connection open, which
is how a fleet-wide singleton becomes a fleet-wide outage. The instance that did
not get it should do nothing and try again next period.

## Example

```ts
const locks = postgresLocks(db, JOBS_NAMESPACE);

// The singleton path, which is all `jobs` needs:
const result = await locks.withLock('identity.purge', () => purge());
if (result === undefined) return; // another replica has it

// lifecycle, on the way down:
lifecycle.add({ name: 'locks', stop: () => locks.releaseAll() });
```

## Gotchas

- **The contract suite cannot assert the survives-holder-death property**, and
  does not pretend to. The memory adapter is one process, so there is no other
  process to lose; a suite that "proved" crash-safety against an in-process
  `Set` would give exactly the confidence that must not be given. The test lives
  beside the PostgreSQL adapter, where `pg_terminate_backend` can really kill a
  session, and it is the reason this section exists.
- **Not reentrant.** The same client asking twice is still two holders, because
  each lease takes its own session. An adapter that allowed it would agree with
  neither the other adapter nor with what a second replica sees.
- **A refused acquire must give its connection back immediately.** Twenty
  refusals each keeping a connection would exhaust the pool during exactly the
  contended period the lock exists to handle. There is a test that does twenty.
- **A session whose backend died must return itself.** The caller that would
  release it is, in that scenario, gone — so waiting for a release that never
  comes leaves the client checked out and `pool.end()` waiting on it forever.
  This surfaced as a **30-second teardown hook timeout**, long after the test it
  belonged to had passed.
- **`withLock` must release when the work throws.** A lock leaked by an
  exception is held until the process dies, and for a singleton that means the
  fleet stops running the job — the worst outcome, arriving from the failure
  that was supposed to be handled.

## Used in

- `src/shared/lock/index.ts`
- `src/shared/jobs/scheduler.ts`

This list grows to anything needing fleet-wide exclusion: leader election, a
`work` queue's maintenance, and `maintenance` migrations when they land.

## Related

[[jobs]] — the only consumer, and why these two are one unit of work.
[[postgres]] — `Session`, which exists because this module needed a connection
it owns. [[digest]] — the same `sha256`, here reduced to 64 bits. [[lifecycle]]
— `releaseAll` on the way down, so a rolling deploy does not strand the fleet's
singleton.
