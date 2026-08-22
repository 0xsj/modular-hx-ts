---
module: jobs
layer: L2
---

# Jobs

## What

Periodic maintenance under one roof. A declared `Job` — `area.verb`, a period
with jitter, a timeout, a singleton flag — and a scheduler that supplies
everything else: minted provenance, failure containment, a span, and uniform
logging from a returned count.

```
add(job) · list() · runNow(name) · start() · stop()
```

## Why

### Singleton is why `jobs` and `lock` are one unit of work

`singleton: true` means the job takes a **fleet-wide lock**, so N replicas run it
exactly once. That is what lets this architecture deploy as **one Deployment
with N replicas and no separate cron process** — which is the thing most teams
get wrong, and the reason it is worth building properly rather than bolting a
`CronJob` beside the app.

The closing condition for both modules is one test: two schedulers, concurrent,
against **one real database**, and the job body executed once. Two in-process
schedulers sharing a `Set` would prove nothing about two pods sharing a
database, which is why it lives at rung 2.

### Non-singleton is the default, and it is explicit

A cache sweep is local; every instance should do its own. Making the default
implicit is how a destructive job ends up running N times because nobody wrote
the flag — so `singleton` is a declared field with a stated default rather than
an inferred one.

### Provenance is minted, never derived — a job is a root

`../PROVENANCE.md` §4, the **mint** row: actor `system:jobs/<name>`, a fresh
request id, correlation **equal to that request id**, and no causation.

Getting this wrong is quiet. The job runs, the records are written, and nothing
joins to anything — the audit and lineage graphs simply have an unattached
island where the maintenance was. Contrast with a subscriber, which **derives**
because it is not a root; the two look similar and are opposite.

### Jitter is not decoration

Every instance starting at the same second means N instances racing the same
lock every period, and the losers each pay a round trip to find out. Jitter
spreads them; the singleton lock makes the outcome correct either way.

The two are complementary rather than redundant: without the lock, jitter only
makes a collision less likely. Without jitter, the lock is correct and the fleet
still stampedes the database once a period.

### Overlap is refused, not queued

A job that overruns its period must not be started again while the previous run
is still going — **an overlapping purge is two workers deleting the same rows.**

Skip this tick, rather than wait. Waiting turns one slow run into an unbounded
queue of pending runs that all fire at once when it clears, which converts a
slow job into an outage at the moment it recovers.

### Failure is contained, and the timeout is a signal

One job throwing must not take the scheduler down and must not stop the jobs
beside it: a dead scheduler stops **all** maintenance, which is far worse than
the single job that failed.

The timeout aborts the run's `AbortSignal` rather than killing anything, so the
report says `timed-out` rather than claiming the work stopped — code that
ignores a deadline cannot be interrupted from outside. Same reasoning as
`lifecycle`'s stop timeout.

### An operator needs a door

`list()` and `runNow(name)` exist because **an operator who cannot invoke a
purge without waiting for its period will invoke it with SQL instead** — the
same work with none of the locking, provenance or logging, run by hand at the
moment things are already going wrong.

## Example

```ts
scheduler
  .add({
    name: 'identity.purge',
    period: hours(1),
    timeout: minutes(10),
    singleton: true,               // one replica, fleet-wide
    run: async ({ provenance, signal }) => purgeExpired(provenance, signal),
  })
  .add({
    name: 'cache.sweep',
    period: minutes(5),            // singleton defaults to false: local work
    run: () => cache.sweep(),
  });

lifecycle.add({ name: 'jobs', start: scheduler.start, stop: scheduler.stop });
```

## Gotchas

- **`run` returns a count.** That is what the scheduler logs, so every job
  reports progress identically without each one inventing a log line.
- **`singleton: true` needs `lock` wired to something shared.** With
  `memoryLocks` it is per-process, which is correct for `STORAGE=memory` — one
  process — and wrong the moment there are two.
- **`stop()` releases every lock this instance holds.** A rolling deploy must
  not leave the fleet's singleton locked by an instance that has gone.
- **Timers are `unref`'d.** The scheduler must not be the reason a process stays
  alive; `lifecycle` owns that decision, and a scheduler that kept the loop open
  would make a clean shutdown impossible to distinguish from a hang.
- **Jobs are registered before `start()`.** A job added afterwards would never
  be scheduled and would still appear in `list()`, which is worse than refusing.
- **A failing singleton must still release its lock.** Otherwise the fleet stops
  running that job entirely — tested directly, because it is the failure mode
  with the largest blast radius and the smallest symptom.

## Used in

- `src/shared/jobs/index.ts`
- `tests/integration/jobs/singleton.test.ts`

This list grows to `identity` (session and challenge expiry), `audit`
(retention), and the `outbox` relay, which becomes a job rather than a loop.

## Related

[[lock]] — the fleet-wide mutex, and why these two are one unit of work.
[[provenance]] — the mint row, and the contrast with a subscriber that derives.
[[lifecycle]] — the scheduler is a component with `start` and `stop`.
[[telemetry]] — a span per run, so a job that is slow is visible next to the
requests it competes with. [[clock]] and [[random]] — injected, so a one-hour
period and its jitter are testable instantly. [[events]] — where the outbox
relay lives today, and which this will drive.
