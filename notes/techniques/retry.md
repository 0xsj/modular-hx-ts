---
module: retry
layer: L0
---

# Retry

## What

Kind-aware backoff with full jitter. `makeRetry(clock, random)` returns a
function that runs an operation, and repeats it only while the failure is one
that could plausibly succeed unchanged. `backoffFor` is the pure schedule;
`DEFAULT_POLICY` is four attempts, 50ms base, 2s cap.

Everything it needs is injected — a `Sleeper` to wait, `Random` to jitter —
which is what lets a test verify an hour of backoff in a millisecond.

**`Sleeper` is declared here, not imported from [[clock]].** Waiting is off the
`Clock` port because interfaces belong to the consumer; `systemClock()` and
`fakeClock()` both satisfy this one, so wiring costs nothing and the shape stays
ours.

## Why

Retrying looks like a loop with a `sleep` in it and is two decisions, both
usually missing.

### Kind-aware

Only a failure that could succeed unchanged is worth repeating. A retried
`Forbidden` is four identical denials and four times the load. A retried
`Conflict` re-reads nothing, so it reproduces the version mismatch it just saw.
A retried `Invalid` sends the same bad input again.

[[errors]] decides this once, in `isRetryable`, so this module and [[breaker]]
cannot drift apart — two components disagreeing about what "transient" means is
how a circuit opens on failures nobody was retrying.

### Jittered, and fully

Backoff without jitter synchronises. Every client that failed in the same second
sleeps the same 200ms, wakes together, and hits the recovering dependency as one
wave — which fails, and re-forms the herd on a longer timer. The outage lasts as
long as the retries do.

**Full jitter**, `random(0, min(cap, base × 2^(n-1)))`, from AWS's *Exponential
Backoff and Jitter*. The exponential part spreads load over time; the random
part spreads it over clients.

**Rejected: equal jitter** (`half + random(0, half)`). It reads safer because it
keeps a floor under the delay, and that floor is the problem — it holds every
client inside the same narrow window. Full jitter decorrelates them completely,
and the handful of clients that draw a short delay are exactly the gentle probe
a recovering dependency can absorb.

**Rejected: a fixed number of retries with a fixed delay.** Simple, and it makes
the herd worse: fixed delay is perfect synchronisation.

## Example

```ts
// Wired once in the composition root, with the real clock and CSPRNG.
const retry = makeRetry(systemClock(), systemRandom()); // the clock satisfies Sleeper

// In an adapter: the description becomes the wrapping context.
const rows = await retry(
  () => pool.query(SELECT_USER, [id]),
  'query user by id',
  { policy: DEFAULT_POLICY, signal, onRetry: ({ attempt, delay }) => metrics.retry(attempt, delay) },
);

// In a test: an hour of backoff, and no real time passes.
const clock = fakeClock();
const retry = makeRetry(clock, fakeRandom(1));
const running = retry(flaky, 'rebuild index', { policy: patient });
await clock.advance(hours(24));
expect(isOk(await running)).toBe(true);
```

## Gotchas

- **A cancelled sleep ends the retry; it does not become another attempt.** Easy
  to get wrong — if the abort surfaces as just another failure, an aborted
  operation retries *harder* than a live one.
- **Clamp before doubling.** `2 ** 1024` is `Infinity`, and `Infinity` reaching
  `random.int()` is a hang rather than an error. `Math.min(cap, …)` comes first,
  and there is a test at attempt 5,000.
- **`DEFAULT_POLICY` is sized for an in-request retry** — worst case under three
  seconds, which a caller's own deadline can absorb. Background work that can
  afford to wait should raise both numbers at the call site rather than editing
  the default, because the default is what an unthinking call site gets.
- **Retrying a non-idempotent write is not this module's decision.** It repeats
  whatever it is given. `POST` without an idempotency key retried after a
  timeout is a double charge, and the timeout is exactly when you cannot tell
  whether the first one landed.
- **`onRetry` exists because L0 cannot log.** A retry nobody can see is a
  latency spike nobody can explain. Wire it to metrics at the composition root.
- **It found a bug in [[clock]].** `fakeClock.advance` used to yield a single
  microtask between wakes, which is enough only when the woken code sleeps again
  immediately. This loop wakes, awaits the operation, wraps the result and
  computes a backoff first — so `advance` saw nothing due, returned, and left
  the caller parked forever. `advance` now drains the microtask queue via a
  macrotask, and the clock suite has a regression test. A fake is only as good
  as its first real consumer.

## Used in

- `src/shared/retry/index.ts`
- `src/shared/retry/index.test.ts`

This list grows to `httpclient`, the outbox relay, and every adapter that talks
to something across a network.

## Related

[[errors]] — `isRetryable`, and the classification that makes this kind-aware.
[[clock]] — waiting, and the fake that makes the tests instant. [[random]] —
the jitter. [[result]] — what an attempt returns. [[breaker]] — the other half
of the resilience pair: retry handles a blip, a breaker stops calling something
that is already down. Retrying through a dependency that is truly gone is how a
partial outage becomes a total one.
