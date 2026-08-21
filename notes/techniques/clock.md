---
module: clock
layer: L0
---

# Clock

## What

Time behind a port. `Clock` has three methods — `now()` for wall-clock time,
`monotonic()` for elapsed time, and `sleep()` for waiting cancellably — with two
implementations: `systemClock()`, and `fakeClock()` which only moves when a test
moves it.

`Millis` is a branded number with `millis`, `seconds`, `minutes` and `hours`
constructors.

This is the only file in the repository permitted to read `Date.now`,
`new Date()` or `performance.now()`. Rule `M2` enforces that.

## Why

Invariant I5: **time, randomness and identifiers are injected.** The usual
argument is testability, and it is a good one — a retry suite with an hour of
backoff in it finishes in a millisecond instead of an hour. But the real reason
is in `../ARCHITECTURE.md` §6: *a dependency you cannot fake is a dependency you
have not inverted.* A module calling `Date.now()` has a dependency it never
declared, that no caller can substitute, and that no test can control. It is an
undeclared global, and it is exactly as bad as any other one.

### Two clocks, because they answer different questions

This is the part most implementations get wrong, and it is not a testing
concern at all.

**Wall-clock time** is what you store in `created_at`, put in an event envelope,
and compare against another machine. It is also **not monotonic**: when NTP
corrects a drifting host, it steps backwards. Code that measures a duration by
subtracting two `Date.now()` readings will, occasionally and unreproducibly,
compute a negative elapsed time — and whatever it feeds (a timeout, a backoff, a
latency metric, a rate limiter) behaves absurdly for one request in a million.

**Monotonic time** never decreases and has no meaning as an absolute value. It
answers "how long did that take", and nothing else.

The port exposes both because the choice belongs to the caller and is easy to
get wrong silently. `notes/techniques/clock.md` has a test for it: advance ten
seconds, jump the wall clock back six years, and the monotonic reading still
reports exactly ten seconds.

**Rejected: returning epoch milliseconds from `now()`.** `Date` is what a driver
binds to a `timestamptz`, what `toISOString()` formats, and what a debugger
prints readably. A number would need converting at every use.

**Rejected: a global `setSystemTime`-style fake.** Vitest and Jest can both
monkey-patch the global clock. It works, and it makes the dependency invisible
again — the code still reads the global, the test just lies to it. Nothing in
the signature says a function depends on time, so nothing stops a module in
`domain/` from reading it, and `M2` would have nothing to check.

## Example

```ts
// Injected, like every other dependency.
export function makeRetry(clock: Clock) {
  return async function retry<T>(op: () => Promise<T>, signal: AbortSignal) {
    let backoff = millis(50);
    for (;;) {
      const started = clock.monotonic();              // elapsed: monotonic
      const result = await attemptAsync(op, 'attempt');
      if (isOk(result) || !isRetryable(result.error)) return result;

      recordLatency(clock.monotonic() - started);
      await clock.sleep(backoff, signal);             // cancellable
      backoff = millis(backoff * 2);
    }
  };
}

// In a test: an hour of backoff, and no real time passes.
const clock = fakeClock();
const running = retry(flaky, signal);
await clock.advance(hours(1));
```

## Gotchas

- **`advance` keeps going after each wake.** A woken continuation usually starts
  another sleep — every backoff loop does — so an `advance` that stopped at the
  first wake would deadlock them. It re-checks after yielding to the
  microtask queue, and there is a test for a sleep started by the sleep it woke.
- **A zero-duration sleep still yields.** Resolving synchronously would make the
  fake and the real clock disagree about ordering, and a test would pass that
  production does not.
- **`pending()` is a leak detector.** A test that finishes with sleeps
  outstanding has an operation that was abandoned without being cancelled.
  Assert it is zero.
- **`sleep` rejects with `Canceled`, it does not resolve early.** A sleep that
  resolved on abort would tell its caller the wait completed, and the caller
  would proceed as if it had.
- **`Millis` is branded for one reason**: the most common time bug is a unit
  mix-up, and a number meaning seconds passed where milliseconds are expected is
  wrong by a factor of a thousand and typechecks perfectly. See [[brand]].
- **`fakeClock` starts at a fixed instant**, deliberately not "now". A test that
  starts at the current time depends on the day it runs, and will eventually
  fail on a leap day, a DST boundary, or a year rollover.

## Used in

- `src/shared/clock/index.ts`
- `src/shared/clock/index.test.ts`

This list grows to include [[retry]] and [[breaker]] first, then every adapter
that stamps a row and every use case that compares an expiry.

## Related

[[errors]] — an aborted sleep rejects with `canceled`. [[brand]] — what makes
`Millis` a distinct type. [[retry]] and [[breaker]] are the first callers, and
the first tests that would be slow without a fake. [[id]] and [[random]] are the
other two halves of invariant I5: time, randomness and identifiers.
