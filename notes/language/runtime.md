---
topic: node and esm runtime
---

# The runtime — ESM, the event loop, and ambient context

## What

What Node actually does, where it differs from what the code looks like it does,
and the three places that difference has cost real debugging time here.

## Why

### ESM, and the `.js` extension on TypeScript imports

```ts
import { systemClock } from '../clock/index.js';   // the file is index.ts
```

Under `nodenext` resolution, the specifier is what Node will resolve **after**
compilation, so it names the emitted `.js`. It looks wrong and it is right; the
alternative is a bundler, and this repository does not have one because
`erasableSyntaxOnly` lets `tsx` and Node run the source directly.

`node:` prefixes on builtins for the same reason — an unprefixed `fs` can be
shadowed by a package called `fs`, and the prefix cannot.

### Top-level `await` is available, and changes how gates are written

`tests/testx/gate.ts` and `src/main.ts` both use it. It is what lets a module
resolve something asynchronously before anything importing it runs — but see the
gotcha, because "before anything importing it runs" is per **module graph**, and
in vitest that means per worker.

### AsyncLocalStorage, and the one place it is deliberately not used

`provenance` rides an `AsyncLocalStorage`, so a log line written by code that
never asked for provenance still carries a correlation id. The scope follows
`await`, `then`, timers and streams, so nothing has to thread it.

`postgres` deliberately does **not** carry the transaction that way, and the
reason is worth repeating here because the mechanism is the same and the
conclusion is opposite: nothing branches on provenance, so missing it degrades
observability and grants nothing. A repository that missed an ambient
transaction would **write outside it and report success**. Same tool, different
failure cost. ADR 0008.

### The event loop does not stay open for a signal handler

`process.on('SIGTERM', …)` does **not** ref the loop. A process whose components
reference nothing — no server listening, no timer pending — drains and exits
**before any signal arrives**, with code 13 and "unsettled top-level await".

This bit twice: once in `main.ts`, and again the moment `lifecycle` took the job
over. `handleSignals` now holds a keep-alive handle for exactly as long as it is
waiting, and `process.getActiveResourcesInfo()` is what the test asserts on.

### Draining the microtask queue is not one `await`

A single `await Promise.resolve()` yields the microtask queue once. Code that
awaits in a loop — a retry with backoff, a relay draining a batch — needs more
than that, and `fakeClock.advance` deadlocked until it drained via
`setImmediate`, which yields to the **macrotask** queue and lets everything
queued behind a timer run.

The regression test for that lives in the `clock` suite rather than in `retry`,
because the defect was in the clock.

## Gotchas

- **Top-level await in a test helper runs per worker, not per run.** The
  database probe was written that way and produced one connection attempt and
  one duplicate warning per worker. It moved to vitest's `globalSetup`, which
  runs once in the main process and hands the result to workers via `provide`.
- **`import.meta.dirname` needs Node 20.11+**, and is the ESM replacement for
  `__dirname`. `fileURLToPath(import.meta.url)` is the portable spelling and is
  what the rule tests use.
- **A `pg` client that dies mid-transaction emits `error` on *itself*, not on
  the pool** — and an unhandled `error` event takes the process down. Pool-level
  handlers do not cover a checked-out client.
- **A dying connection emits twice**: the real cause first, then a code-less
  "Connection terminated unexpectedly". Keep the **first**; the second is its own
  consequence.
- **`process.env` values are `string | undefined`** and, under
  `noUncheckedIndexedAccess`, must be read with bracket access. Only the
  composition root and the test harness read it at all.
- **An `unhandledRejection` warns and continues by default**, which is how a
  half-dead process keeps serving traffic. `main.ts` exits instead.

## Used in

- `src/shared/provenance/carrier.ts`
- `src/shared/lifecycle/index.ts`
- `src/shared/clock/index.ts`
- `tests/testx/global-setup.ts`

## Related

[[provenance]] — ambient carriage, and the boundary rule for it. [[lifecycle]] —
the signal handling and the keep-alive. [[clock]] — the fake, and the microtask
drain. [[postgres]] — the client-error handling. [[strictness]] — why
`process.env` is read the way it is.
