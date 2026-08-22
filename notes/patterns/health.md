---
module: health
layer: L1
---

# Health

## What

Two questions, deliberately kept apart:

| | asks | decides | checks dependencies |
| --- | --- | --- | :-: |
| **Liveness** `/healthz` | is this process broken beyond recovery? | whether it is **restarted** | **never** |
| **Readiness** `/readyz` | should this instance receive traffic? | whether it stays in the **pool** | yes |

Checks register as `critical` or `optional`. `drain()` reports not-ready without
stopping anything.

## Why

### Conflating the two is a specific, well-known outage

If liveness checks the database, a database blip restarts **every pod at once**.
They all reconnect simultaneously, which is the worst possible load on a
dependency that was already struggling, and a bad minute becomes a bad hour —
the orchestrator amplifying an outage it was meant to protect you from.

So liveness runs no checks at all. Reaching the end of the function *is* the
answer. Conformance 41: *`/healthz` reflects liveness only; `/readyz` reflects
dependencies.*

### Critical versus optional is the module

A failing **critical** dependency means this instance cannot serve, so it leaves
the pool. A failing **optional** one means **degraded, never down**.

`../INFRASTRUCTURE.md` §7.4 names the trap that makes this worth encoding: a
backlog must not fail readiness, because failing it *hands your traffic to the
instances already behind on the same queue*. The queue is shared; removing the
one instance still draining it makes the backlog worse. Conformance 42 says the
same thing: a backlog degrades readiness reporting but never fails it.

Most things are optional. A checker is critical only when serving a request
without it produces a **wrong answer** rather than a slower one.

### Three states, because the middle one is the useful one

`degraded` is what a dashboard shows and an alert fires on, without taking the
instance out of rotation. Two states would force every partial failure to be
either invisible or fatal.

### Draining is a decision, not a check

`drain()` flips readiness to unhealthy while the process stays fully assembled.
Registered **last** in the lifecycle so reverse order stops it **first**: the
load balancer stops sending work before anything begins closing, and in-flight
requests finish against a complete process. `../INFRASTRUCTURE.md` §7.3.

Liveness deliberately still passes while draining, or the orchestrator would
restart the process in the middle of the drain it is waiting for.

## Example

```ts
const health = makeHealth({ clock });

health
  .add({ name: 'postgres', importance: 'critical', run: () => pool.query('select 1') })
  .add({ name: 'outbox-backlog', importance: 'optional', run: backlog.check });

// Registered last, so it is stopped first.
lifecycle.add({ name: 'traffic', stop: () => { health.drain(); } });

// httpx, when it lands:
routes.get('/healthz', () => reply.code(statusCode(health.live())));
routes.get('/readyz', async () => reply.code(statusCode(await health.ready())));
```

## Gotchas

- **`degraded` serves traffic.** `servesTraffic()` exists so no transport
  compares status strings and gets it wrong in one place out of three.
- **A check that will not answer is a check that failed.** Waiting longer only
  makes the *probe* time out, which the orchestrator reads as a dead process —
  turning a slow dependency into a restart. Each check gets a bounded time and
  a `timed out` result.
- **Checks run concurrently.** A probe that took the sum of its checks would
  exceed its own deadline long before the slowest one mattered.
- **Readiness answers are cached briefly.** Probes arrive from the orchestrator,
  the load balancer and whatever else is watching; each one running a real
  query multiplies that load onto the dependency least able to take it.
  `drain()` discards the cache immediately, because a stale "ready" is the one
  answer that must never survive.
- **A failure message goes in the response.** A probe endpoint is usually
  reachable from more places than you think, so the report carries the error's
  message and `Kind` and never internals.
- **Liveness must keep passing during shutdown.** A restart mid-drain kills the
  in-flight requests draining exists to protect.
- **Testing concurrency by start order proves nothing.** Sequential execution
  produces the same order when each check records itself before awaiting. What
  separates them is whether every check *began* before any *finished* — which
  is what the test asserts, after the first version did not.

## Used in

- `src/shared/health/index.ts`
- `src/main.ts`

This list grows to `postgres`, `events`, `mailer` and `backlog` — each
registering a check, and each choosing critical or optional deliberately.

## Related

[[lifecycle]] — registers draining last so it stops first. [[clock]] —
injected, and what makes a two-second check timeout testable instantly.
[[errors]] — a check's failure keeps its `Kind`, so a probe response is as
queryable as a log line. [[logger]] — where the answer is reported until
`httpx` can serve it.
