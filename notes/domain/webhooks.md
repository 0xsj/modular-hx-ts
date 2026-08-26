---
context: webhooks
---

# Webhooks — one event in, N deliveries out

**One event in, N deliveries out, to servers we do not control.**

The showcase context that reaches outward. Everything else in this repository
answers a request or writes a row; this one makes a request, to an address
somebody else chose, and has to survive whatever comes back.

## What

Three things, and everything else is substrate:

- **What a destination is allowed to be.** `domain/destination.ts`.
- **What gets signed.** `domain/signature.ts` — and the receiver reimplements
  exactly that, which is why it is a pure function with its own test rather than
  a detail of the sender.
- **What a failure costs.** A delivery is retried on a schedule; an endpoint
  that has failed twenty times running disables itself.

The per-attempt timeout, the capped read, the status→`Kind` map, the circuit and
the backoff are all one layer down. `httpclient`, `breaker` and `retry` had been
built, tested and **referenced zero times from any context in the collection**
before this. That was the point of building it.

## Why

Because the failure modes of talking to somebody else's server are not the
failure modes of anything else here, and they are not one failure mode either.

### The two retry loops, and why they are two

`retry` handles a flapping socket **inside one attempt** of a delivery: two
tries, milliseconds apart, for the case where a connection was reset.

The delivery's own schedule — 1 minute, 5, 30, 2 hours, 10 — handles a
**receiver that is down**. Conflating them is how a sender turns a receiver's
bad minute into thirty requests.

The schedule is a table rather than an exponent because the numbers a receiver
actually experiences are the specification, and a formula makes you compute what
you could have read.

## Gotchas

### The bug worth remembering

A failed delivery was written `pending` with a `next_attempt_at`, and **nothing
read it**. The job that had just run completed successfully, so the queue was
empty; the row said *we will try again in a minute*, the delivery log showed it,
and no retry ever happened.

Every test passed. All of them drove `deliverOne` directly, so all of them
observed the row and none observed the queue. The case that caught it drains the
worker six times and asserts what **left the process** — `h.received` — rather
than what the row says about itself.

> A test that reads the state a function wrote is checking the function agrees
> with itself.

### Loops

An endpoint that subscribed to `webhooks.*` would receive its own delivery
outcomes: a failure publishes a failure event, which produces a delivery, which
fails. It is not slow — one publish per attempt, growing.

It is refused **twice**: the domain refuses the subscription, and the fan-out
refuses to fan out anything under the prefix. Either alone is enough today.
Neither alone survives somebody adding a second way to create an endpoint.

### What is deliberately missing

- **`dlq`.** An exhausted delivery is visible in the delivery log and replayable
  by its owner, which is the useful 90%. Operating dead letters across every
  producer is `dlq`'s job and its trigger is a second producer needing it.
- **A persistent keyring.** Secrets are derived under the installation MAC key,
  and the root mints an ephemeral one — so a restart invalidates every receiver's
  stored secret. That is survivable for `identity`'s ten-minute links and it is
  not survivable here. `KEYRING` in configuration is the fix, and it is the same
  fix for all three contexts that mint one.
- **Address pinning at connect time.** `destination.ts` closes the obvious SSRF
  door at registration; a name that resolves to a private address walks through
  it. The complete answer belongs to the dialer, in `httpclient`.

## Used in

`src/wire.ts` mounts it and hands its subscription to the bus, exactly as it
does `audit`'s — which is the property that keeps this context from being
special: it learns about an event the same way, and no publisher knows either
exists.

`WEBHOOKS_ENABLED=false` removes the routes and the subscription. Nothing else
changes, and nothing else can tell.

## Related

- `notes/patterns/httpclient.md` — the per-attempt timeout, and why the body is
  never in the message
- `notes/domain/exports.md` — the other `work` consumer, and the reason having
  two matters: a substrate module used by exactly one context is a module shaped
  like that context
