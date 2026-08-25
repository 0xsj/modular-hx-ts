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

### Refill uses wall time, passed in — the narrow exception to M13

**This section used to argue the opposite, and the argument was good.** It said
the memory adapter satisfied `M13` exactly with `clock.elapsed()`, that
PostgreSQL exposes no monotonic clock so the shared adapter had to use the
database's `now()`, and that the arithmetic bounded the resulting error in both
directions. Every sentence of that was true. It was still the wrong design, and
the note is exactly why nobody looked again: a paragraph explaining a shortcut
is what stops the shortcut from being re-examined.

What it missed is that **two adapters reading two clocks cannot run one contract
suite**. `I2` requires them to. The suite could advance the twin's fake clock
and could not advance PostgreSQL's, so the refill cases — the behaviour a token
bucket *is* — ran against a fake instant in one adapter and a real two-second
wait in the other. They were not the same test. The suite proved the two agreed
on everything except the one thing worth agreeing on, and the window had to be
adapter-chosen to hide it.

`MODULES.md` §5 settles it: **the reading is a parameter**. `take(key, limit, at)`.

- The base is **wall time**, and that is the narrow exception `M13` names. A
  monotonic reading is per-process: two replicas' origins are unrelated, so
  their readings cannot refill one shared bucket. `M13` governs durations
  measured *within* a process; shared state has no such option.
- The store **never consults a clock of its own** — not the database's, not the
  host's. One injected clock drives both adapters, which is what makes the
  contract suite a contract.
- Skew between replicas becomes a **known bounded inaccuracy** rather than a
  correctness bug.

The bound is unchanged and is now asserted rather than asserted-about:

- **elapsed is floored at zero**, so a backward step refills nothing rather than
  *draining* the bucket — negative elapsed would otherwise turn a clock
  correction into a throttle nobody configured;
- **the result is capped at capacity**, so a forward step grants one full bucket
  rather than an unbounded burst. That cap is the token bucket's own bound, not
  a special case bolted on.

A year-long jump in either direction costs at most one burst and never a stall,
and there is a test for each direction rather than a paragraph claiming it.

**The alternative that lost, and why.** §5 permits the single-process *fallback*
bucket to keep a monotonic reading, since there it can. This repository does not
take that permission: one adapter with two time bases is how a twin stops being
a twin, and the bound above already makes wall time safe. The cost is one burst
on a clock step in a degraded process, which is smaller than the cost of a
contract suite that only half applies.

### Failing open means degrading, not switching off

`../RESILIENCE.md` §1 puts availability ahead of a broken throttle, and that is
right. But **"the store is unreachable" and "there is no limit" are different
facts**, and a store outage is precisely when an unlimited edge is most
dangerous: whatever took the store down is usually load, and removing the
limiter adds more of it.

So the fallback is a per-process bucket at a **directly configured** degraded
rate. The limit becomes approximate rather than absent, and it self-heals: the
next request tries the shared store again, and recovery is logged as well as the
failure.

**It was `limit / replicas`, and that shape is rejected.** The reasoning was
that the fleet should still approximate the configured rate instead of
multiplying it by the replica count, which is arithmetically true and is not the
question. `MODULES.md` §5: **a process must not be told its own fleet size.** It
cannot verify the number, the orchestrator already owns it, and it goes stale in
silence — scale from four replicas to twelve without editing the config and each
of the twelve admits a quarter of the limit, which is three times the limit,
discovered by a customer. `jobs` establishes the same principle from the other
side, using a fleet-wide lock precisely so N replicas need no configured N.

**The default is the full limit, and that is stated rather than disguised.**
During an outage N replicas then admit N×limit collectively. A share calculation
would *imply* the aggregate is preserved, and the thing the outage took away is
the coordination that made an aggregate meaningful. Per-process limiting still
stops one caller hammering one replica, which is exactly what "approximate
rather than absent" buys. An operator wanting tighter behaviour sets the number
— usually more conservatively than any share would allow, since a store outage
tends to arrive with load.

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

**Trust is a set of CIDR prefixes, and there is no default.**

The two costs of getting this wrong are not the same size:

- Trusting the header hands every caller a **limit-evasion primitive** — a new
  address per request is a new bucket, and the limiter becomes decorative.
- Worse, it lets one caller **exhaust another's bucket** by forging their
  address. That turns a throttle into a denial-of-service tool aimed at a
  specific victim, which is a strictly worse outcome than having no limiter.

**This was `trustedProxyHops: number`, counting from the right, and the note
argued for it well.** The argument was that `X-Forwarded-For` is appended to by
each hop, so with one trusted proxy the last entry is the address that proxy
observed — and that taking the *leftmost* entry is the classic bug, which is
true. The note was right about the bug it named and wrong about the fix, and it
read convincingly enough that nobody checked.

**A hop count is positional, so it fails open under any topology change.**
`trustedProxyHops: 1` means *the last entry is the client*. Add a second proxy,
or let one request reach the process directly, and the entry at that position is
one the caller wrote. Nothing looks wrong: the header is present, the count is
satisfied, and the limiter is keying on an attacker-supplied address. The
failure needs no attacker to arrange — an infrastructure change is enough, and
the symptom is silence.

**Prefixes fail closed in the same situations.** Walk `X-Forwarded-For` right to
left, skipping addresses inside the trusted set; the first one outside it is the
client. An extra trusted hop is skipped. An unrecognised address ends the walk.
A request that arrives directly has an untrusted peer, so the header is ignored
entirely and the transport peer — which cannot be forged — is used.

**`X-Real-IP` is gated by the same set and loses to `X-Forwarded-For`**, read
only when XFF is absent. XFF carries a chain that can be *validated* by walking;
`X-Real-IP` is a single unverifiable assertion, and commonly a less accurate one
— a proxy typically sets it to its own immediate peer, which behind two proxies
is not the client.

**Unset refuses to boot, and both candidate defaults are wrong in the same
way.** Trusting by default is the limit-evasion primitive above. *Not* trusting
by default is equally broken behind a load balancer, where every caller shares
one bucket and the limiter is global — failing conformance case 40 on the first
day of any real deployment while looking perfectly safe. So the set is stated
explicitly, `none` is a legal explicit value and what development uses, and an
absent setting refuses the process. Same shape as an unresolvable secret.

**The ignored header is logged, sampled.** The failure this prevents is social:
silently ignoring a populated header looks like a bug, and the obvious fix
somebody reaches for is to trust it unconditionally. Sampled rather than per
request, because every request behind a misconfigured proxy carries one and
per-request logging would bury the line it exists to make visible.

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
      // Absent means the full limit while the store is down. Configured, never
      // derived from a replica count.
      degradedLimit: { limit: 40, window: minutes(1) },
      // Refuses when unset. `none` is the legal explicit answer.
      trust: trustedProxies(process.env.TRUSTED_PROXIES),
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
- **The contract suite's window is one number for both adapters, and it used to
  be two.** The twin drove an injected clock and a ten-second window cost
  nothing; the shared adapter had to *wait*, so it used two seconds — and the
  refill cases were therefore not the same test in the two adapters. Moving the
  reading into `take` removed the reason, and nothing in the integration suite
  waits any more, which also made those cases exact rather than *long enough on
  this machine*. Every case is still written in fractions of the window, because
  the contract is the behaviour rather than the number.
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
- **The degraded rate sizes only the fallback.** It has no effect while the shared store
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
