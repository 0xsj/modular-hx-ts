---
module: ratelimit
layer: L4
---

# Rate limiting

## What

Position 7 of the `httpx` chain, and the last of the three slots it left named
and empty.

```
take(callerKey, limit) -> allowed | refused, with remaining and reset
```

A token bucket behind a port with a shared implementation and a memory twin, one
contract suite both pass, and a middleware that degrades rather than switches off
when the store is gone.

## Why

### A per-process bucket is not a rate limit

Four replicas each admitting the configured rate admit four times it. **Every
single-instance test passes.** That is the whole reason this is a port with a
shared implementation rather than a map in a closure, and it is the failure that
looks exactly like success — the dashboard shows a limiter working, the bill
shows four.

So the contract suite carries **two limiters over one store**, and that case is
the one that earns its place. Every other case in the file passes against a
private per-process map: admits five, refuses the sixth, refills over time,
separates callers. Only two limiters sharing one budget tells a real limiter
from a local one, and without it the memory twin and the shared adapter agree
while one of them is wrong.

The memory adapter's store is therefore a **separate value from the limiter** —
`memoryBucketStore()` then `memoryBuckets(store, clock)`. A factory that hid its
own map inside a closure could not express two limiters over one store, so the
suite could not have asked the question.

### Check-and-consume is atomic

Read-then-write means two concurrent requests both observe the last token and
both are admitted. The same trap as `idempotency`'s claim, and the resolution is
reused rather than rediscovered: one statement that refills, decides and writes.

Two details carried over from that module. The refill expression appears twice
in the SQL — once in `set`, once in `where` — and the duplication is deliberate,
because the `where` of an `on conflict do update` is evaluated against the
**latest row version** while anything moved outside it reads the statement's
opening snapshot. And when the statement returns nothing, that means *something
blocked us that we cannot see*, not *nothing is there*.

**What differs is what we do about it, and the difference is the point.**
`idempotency` resolves that ambiguity by refusing; this module resolves it by
admitting. Neither is a preference: one caller getting one extra token in a race
costs a rounding error on a throttle, and one execution proceeding unclaimed
costs a duplicated write.

### Refill is monotonic — rule M13

A token bucket refills by elapsed duration, so a wall-clock step backward stalls
every bucket until real time catches up, and a step forward hands out a full one.
This is the shape that bit `breaker` twice in this collection.

The memory adapter satisfies `M13` exactly: the reading is `clock.elapsed()`,
and the test moves wall time a year in each direction without moving the
monotonic reading at all.

**The shared adapter cannot, and that is a real limitation rather than an
oversight.** PostgreSQL exposes no monotonic clock — there is no counterpart to
`performance.now()` in SQL — and a per-process monotonic reading is meaningless
in shared state, because two processes have two unrelated origins. So it
measures against the database's own wall clock, which is at least *one* clock
rather than N.

The arithmetic bounds both directions of the error, and that is the second half
of the protection rather than a consolation:

- **elapsed is floored at zero**, so a backward step refills nothing rather than
  *draining* the bucket — negative elapsed would otherwise turn a clock
  correction into a throttle nobody configured;
- **the result is capped at capacity**, so a forward step grants one full bucket
  rather than an unbounded burst. That cap is the token bucket's own bound, not
  a special case bolted on.

A clock correction on the database host therefore costs at most one burst, and
never a stall.

### Failing open means degrading, not switching off

`../RESILIENCE.md` §1 puts availability ahead of a broken throttle, and that is
right. But **"the store is unreachable" and "there is no limit" are different
facts**, and a store outage is precisely when an unlimited edge is most
dangerous: whatever took the store down is usually load, and removing the
limiter adds more of it.

So the fallback is a per-process bucket sized for **one replica's share** —
`limit / replicas`. The limit becomes approximate rather than absent, and it
self-heals: the next request tries the shared store again, and recovery is
logged as well as the failure.

Two things a future reader will simplify, and what each costs:

- **Dropping the fallback and just calling `next`** — "it fails open anyway".
  That is the version where a database blip removes the only thing standing
  between a retry storm and the origin.
- **Building the fallback bucket per request** rather than keeping one. A
  fallback rebuilt per request is a full bucket per request, which is no limit
  at all wearing a limit's shape — and it passes any test that only checks a
  200 came back.

The failure is logged **once**, not once per request: an outage should not also
be a log flood, and the recovery line is what tells an operator the fleet is
sharing a budget again.

### The contrast with `idempotency`, stated because it looks like a bug

These two sit two positions apart in the same chain and answer the same question
in opposite directions:

| | store unreachable | why |
| --- | --- | --- |
| `ratelimit` (7) | **degrade and serve** | a broken throttle must not take the service with it |
| `idempotency` (9) | **503** | executing unclaimed double-applies a write the client asked to have protected |

`../RESILIENCE.md` §1 decides the default by **category**, which is what makes
this obvious rather than a judgement call: availability controls fail open,
data-integrity controls fail closed. A reader who meets both without the
reasoning will assume one is a mistake.

### The caller is the principal; the peer address is a fallback with a precondition

Conformance case 40 requires per-caller limits, which is why position 7 sits
below authn — a limiter that ran first would have no caller to key on. The key
is `principal:<actor>`, or `peer:<address>` for anonymous traffic, prefixed by
kind so an address can never collide with an actor id.

**The tenant is deliberately absent from the key**, and that is an ordering fact
rather than an oversight: position 8 resolves the tenant, and position 7 runs
before it.

**A forwarded-for header is trusted only when a proxy in front is configured as
trusted, and the default is to trust nothing.** A deployment that has not thought
about its topology gets the transport peer, which a caller cannot forge.

The two costs of getting this wrong are not the same size:

- Trusting the header hands every caller a **limit-evasion primitive** — a new
  address per request is a new bucket, and the limiter becomes decorative.
- Worse, it lets one caller **exhaust another's bucket** by forging their
  address. That turns a throttle into a denial-of-service tool aimed at a
  specific victim, which is a strictly worse outcome than having no limiter.

`trustedProxyHops` counts from the **right**, because `X-Forwarded-For` is
appended to by each hop: with one trusted proxy the last entry is the address
that proxy observed, and everything to its left is whatever the caller chose to
send. Taking the leftmost is the classic version of this bug and the one that
reads most naturally — every description calls the leftmost entry "the original
client", which is true only if nobody lied.

A chain shorter than the configured topology yields **nothing** rather than a
clamped guess: the request did not arrive through the proxies this deployment
describes, so no entry is attributable, and the peer address is still true.

### The headers, and why `Retry-After` cannot drift from `Reset`

Case 39 fixes the separate-header form: `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`, plus `Retry-After` on a 429. A newer
combined structured-field form exists; if this repository adds it, it adds it
**alongside** and never instead.

They are on **every** response, not only a 429. A client that learns its budget
only by exceeding it has to exceed it to learn anything, which is a protocol
that rewards exactly the behaviour being limited.

`RateLimit-Reset` here is **how long until this caller's next request would be
admitted** — zero while tokens remain. That is a deliberate reading: the draft
defines it as time until the quota resets, and a bucket that refills
continuously has no window boundary to point at. *Time until you may go again*
is the number a client can act on.

It also makes the agreement **structural**. On a 429 both headers are rendered
from one value, so they cannot drift — rather than two code paths computing two
numbers that are supposed to match. Two numbers that disagree teach clients to
ignore both, and the drift always arrives later, in an edit nobody connected to
either header.

### Position 7 is below position 3, and above position 9

Both facts are load-bearing and both are tested.

**Below the problem mapper**, so a 429 is built by the same code as every other
error: RFC 9457 body, same request id, `err_kind` on the access line. A limiter
that rendered its own 429 would be a second place in the process that builds an
error body.

That created a problem worth naming, because it is a general one. A position
below the mapper **cannot put a header on an error response**: it throws,
position 3 renders, and the code after its own `next` never runs. So the L4
floor gained `Exchange.responseHeaders` — headers this exchange must carry
whatever the outcome, merged by position 1, which already does exactly this for
`x-request-id`. The alternatives were both worse: rendering here duplicates the
mapper, and carrying headers on the error's `details` puts HTTP in an L0
vocabulary, which is what collection decision 0010 rejected for status codes.

**Above idempotency**, so a **replayed** idempotent request still spends budget.
A replay is still a request against this edge; position 9 answers it without
reaching the handler, and position 7 has already counted it. Otherwise a client
with one key and a retry loop is unlimited.

### Liveness and readiness are never limited

Throttling the endpoint an orchestrator polls turns a traffic spike into a
rolling restart — the limiter causing the outage it was installed to prevent,
and doing it fastest exactly when the fleet is busiest.

Exempt means **not counted**, not *counted and forgiven*. A readiness poll every
second would otherwise drain a caller's bucket without ever being refused
itself, which is the same outage by a slower route.

## Example

```ts
const buckets = postgresBuckets(db);

const handler = chain(
  {
    clock,
    origins,
    telemetry,
    authenticate,
    // The slot was named and empty. This is the wiring, in full.
    ratelimit: ratelimit({
      buckets,
      clock,
      limit: { limit: 100, window: minutes(1) },
      replicas: 4,
      trust: { trustedProxyHops: 1 },
      reporter: logger,
    }),
  },
  route,
);
```

## Gotchas

- **Tokens are stored fractional**, and this is the subtle version of "the
  limiter is broken". Rounding to whole tokens on every write floors away the
  fraction that had just accrued, so a steady stream of requests keeps a bucket
  at zero forever — and it looks like the limit working. A test reads the column
  and asserts a fraction.
- **`Retry-After` is never zero.** Telling a refused client to retry immediately
  produces another 429 and a client that hammers, which is the loop the header
  exists to prevent. Rounding down has the same effect one millisecond later.
- **The contract suite's window is chosen by the adapter**, not by the suite.
  The memory twin drives an injected clock and a ten-second window costs nothing;
  the shared adapter has to *wait*, so it uses two seconds. Fixing one number
  would make the suite slow against one adapter or unstable against the other —
  the contract is the behaviour, and every case is written in fractions of the
  window.
- **A full bucket is indistinguishable from an absent one**, which is what makes
  `purge` safe: it changes no answer and only reclaims rows. A purge that
  dropped a bucket mid-spend would be a free refill.
- **`purge` is a `jobs` step, not a request-path one**, and nothing schedules it
  yet.
- **No breaker in front of the shared store.** During an outage every request
  pays one failed round trip before falling back. Connection refused is fast, so
  this is cheap today — but if the failure mode is a *slow* store rather than an
  absent one, the module for that already exists and belongs here. That is the
  trigger, and it is written down rather than assumed.
- **`replicas` sizes only the fallback.** It has no effect while the shared store
  is reachable, and getting it wrong by a factor of two still leaves a limit
  where the alternative is none.

## Used in

- `src/shared/ratelimit/index.ts`

Every route behind the chain except the exempt ones. The composition root wires
one store and one middleware.

## Related

[[idempotency]] — the other half of the fail-open/fail-closed pair, and the
module whose atomic-claim shape this reuses. [[edge]] — the floor, and
`responseHeaders`, which exists because position 7 is below position 3.
[[httpx]] — position 7, and the slot it fills. [[clock]] — monotonic, and the
rule this module is the archetype of. [[breaker]] — bitten twice by the same
clock shape, and the deferred answer to a slow store. [[postgres]] — the upsert,
the snapshot, and `asAppError`. [[provenance]] — where the principal comes from,
and why the order is a precondition. [[errors]] — `exhausted`, and why a 429 is
a `Kind` rather than a status this module writes.
