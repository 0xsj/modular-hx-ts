---
module: lifecycle
layer: L1
---

# Lifecycle

## What

Ordered start, reverse-order stop, and signal handling. Components register in
dependency order; `start()` brings them up in that order and `stop()` takes them
down in the opposite one. `handleSignals()` turns `SIGINT` and `SIGTERM` into a
graceful shutdown.

## Why

A process is a stack, and the second half of its life is the half that gets
written carelessly. Starting things in order is obvious. Stopping them in
**reverse** order is the part that is skipped, and the symptom is a connection
pool closed while a request is still using it — an error at the end of every
deploy that nobody can reproduce, because it needs traffic in flight at exactly
the wrong moment.

Three properties carry the module.

### Reverse order, including after a failed start

The last thing up is the first thing down. That holds when start fails halfway
too: what started is stopped, in reverse, and what never started is never
stopped. A half-started process is worse than a stopped one — it is the state
most likely to be holding a port or a lock that nothing will release.

### A failure to stop does not stop the shutdown

Every remaining component still gets its turn, and the failures are reported
together. One connection that will not close is no reason to leak the other
five.

### Nothing hangs forever

Each component gets a bounded time, and the whole shutdown gets a bounded time.
A process that refuses to exit is eventually `SIGKILL`ed, which loses everything
the *other* components were about to finish cleanly — so abandoning one is
strictly better than waiting for it.

The timeout is a `Promise.race`, not an abort: code that ignores a deadline
cannot be interrupted from outside. The message therefore says **timed out**
rather than **failed**, because the step may well still be running and claiming
otherwise would assert something the process does not know.

`../INFRASTRUCTURE.md` §7.3 is the deployment half of this:
`terminationGracePeriodSeconds` must exceed the grace timeout here **plus the
longest request timeout**, or the orchestrator kills work this was about to
finish.

**Rejected: importing `logger`.** `Reporter` is declared here — three methods,
which `Logger` satisfies unchanged. `logger` is a peer at L1, and the shutdown
path is the last thing that should depend sideways on something that might
itself be shutting down. Same reasoning as `retry` declaring its own `Sleeper`.

**Rejected: printing by default.** Without a reporter it says nothing. A library
that writes to stdout unasked is one nobody can embed.

## Example

```ts
const lifecycle = makeLifecycle({ clock: systemClock(), reporter: log });

// Registration order is dependency order, which is what makes reverse-order
// shutdown correct rather than lucky.
lifecycle
  .add({ name: 'postgres', start: () => pool.connect(), stop: () => pool.end() })
  .add({ name: 'outbox-relay', start: relay.start, stop: relay.stop })
  .add({ name: 'http', start: server.listen, stop: server.close });

if (isErr(await lifecycle.start())) return 70;

const release = lifecycle.handleSignals(() => process.exit(130));
await lifecycle.stopped();
release();
```

## Gotchas

- **A signal listener does not keep Node's event loop open.** A process whose
  components reference nothing — no server listening, no timer pending — drains
  and exits *before* any signal arrives, with code 13 and "unsettled top-level
  await". `handleSignals` holds a handle for exactly as long as it is waiting.
  This bit twice: once in `main.ts` before this module existed, and again the
  moment `main.ts` handed the job over.
- **Registration order is dependency order.** Nothing infers a graph. Register
  what others depend on first, and reverse order does the rest.
- **`stop()` is idempotent.** A second `SIGTERM`, or a signal arriving during a
  manual stop, joins the shutdown already running. Two shutdowns at once would
  stop the same component twice.
- **A second signal is a real message.** The operator has stopped waiting.
  `onImpatience` is where the process exits immediately; ignoring it is how a
  hung process ends up needing to be killed twice.
- **Registration is closed once started.** A component added after `start()`
  would never start and would still be stopped, which is worse than refusing.
- **The grace timeout is not the sum of the component timeouts.** It bounds the
  whole shutdown, so a few slow components can exhaust it and the rest are
  abandoned with a line saying exactly how many.

## Used in

- `src/shared/lifecycle/index.ts`
- `src/main.ts`

This list grows to `postgres`, the outbox relay, `jobs` and `httpx` — everything
with a socket, a pool or a loop.

## Related

[[clock]] — injected, per rule `M2`, and what makes a shutdown test with a
25-second grace period run instantly. [[errors]] and [[result]] — a failed start
returns the original failure wrapped, so its `Kind` survives. [[logger]] —
satisfies `Reporter` without this module importing it.
