---
module: breaker
layer: L0
---

# Breaker

## What

A keyed circuit breaker over a rolling window. `makeBreaker(clock, policy,
onStateChange)` returns something you run calls through, per key — a host, not a
URL. Three states: **closed** passes calls and counts them, **open** refuses
them immediately, **half-open** admits exactly one probe.

It trips when the failure ratio over the recent window crosses a threshold, and
only once enough calls have happened for the ratio to mean anything.

## Why

[[retry]] handles a blip. This handles a dependency that is genuinely down.
Retrying *through* something that is gone is how a partial outage becomes a
total one: every caller holds a connection and a worker for the full timeout,
the queue behind them backs up, and a service that depends on one broken
downstream stops serving the endpoints that never touched it.

### A rolling window, not consecutive failures

**This is the whole reason the module is more than ten lines.** A
consecutive-failure counter resets on every success, so a dependency failing
half its calls never fails twice in a row and never trips — while half of every
caller's requests hang until timeout. That flapping endpoint is the worst case,
not the easy one, and the naive implementation is blind to exactly it.

Counting over a window asks the question that matters: what fraction of *recent*
calls failed. Ten buckets over thirty seconds; a bucket whose epoch has rolled
over is stale rather than additive, so old failures age out instead of being
subtracted.

### Only failures that say something about health

A `Forbidden` is not the dependency being down; it is the caller being wrong.
[[errors]] decides what counts, in `isRetryable`, so this module and [[retry]]
cannot drift apart — two components disagreeing about "transient" is how a
circuit opens on failures nobody was retrying.

### One probe

Half-open exists to ask the dependency a single question. Letting the fleet
through on reset re-creates the load that opened the circuit, against something
that has not answered anything yet. A concurrent second call is refused.

Closing resets the window, which is easy to forget: otherwise the first failure
after recovery re-trips instantly on evidence from before the outage ended.

**Rejected: one global breaker.** One slow host would stop calls to every other.
Keys are why a broken payment provider does not take down search.

**Rejected: keying by URL.** Memory is O(keys × buckets), and per-URL keys mean
a breaker per query string — thousands of windows, none with enough throughput
to reach `minimumThroughput`, so none of them ever trips.

## Example

```ts
// Composition root: one breaker, wired to metrics for invariant I9.
const breaker = makeBreaker(systemClock(), DEFAULT_POLICY, (change) =>
  metrics.circuit(change.key, change.to),
);

// Breaker OUTSIDE retry — see the gotcha below.
const rows = await breaker.run('users-db', () =>
  unwrapOr(retry(() => pool.query(SELECT_USER, [id]), 'query user by id'), []),
  'query user by id',
);
```

## Gotchas

- **Nest the breaker outside retry, not inside.** An open circuit returns
  `Unavailable`, and `Unavailable` is exactly what `isRetryable` says to repeat
  — so a retry wrapped around an open breaker burns its whole budget on
  backoff sleeps without making a single call, then reports failure much later
  than it knew it. Breaker outside means one logical call is one breaker
  outcome, and retry handles the blips inside it.
- **Closing resets the window.** Stale evidence from before the outage would
  otherwise re-trip the circuit on the first post-recovery failure.
- **Key by host, not by URL.** Per-URL keys never accumulate enough throughput
  to trip, and the memory is unbounded in the shape of your traffic.
- **`minimumThroughput` is not optional.** Two failures out of two is a 100%
  failure ratio and no evidence at all. Without a floor, the first two failures
  after a deploy open every circuit.
- **A breaker does not make anything more available.** It converts a slow
  failure into a fast one and protects the caller's resources. The dependency is
  just as down. What it buys is that everything *else* keeps working.
- **`onStateChange` is not optional either.** Invariant I9 requires a fail-fast
  control to be visible when it fires; a circuit that opens silently is an
  outage nobody can explain. L0 cannot log, so the composition root wires it.

## Used in

- `src/shared/breaker/index.ts`
- `src/shared/breaker/index.test.ts`

This list grows to `httpclient` first, and to every adapter that calls something
across a network.

## Related

[[retry]] — the other half of the pair, and the nesting order above. [[errors]]
— `isRetryable`, the shared definition of "transient". [[clock]] — the rolling
window is measured in monotonic time, so an NTP correction cannot make a bucket
appear to be from the future. [[result]] — what a refused call returns.
