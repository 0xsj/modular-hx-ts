---
module: events
layer: L2
---

# Events

## What

A port with **swappable providers**. The outbox is one provider, not the module.

```
events        Event · Envelope · Publisher / Subscriber / Dispatcher
  memory      in-process bus, no durability
  outbox      rows written in the CALLER'S transaction, plus a lease relay
  eventstest  one contract suite; every provider passes it
```

`EVENTS_PROVIDER=memory|outbox`, exactly as `STORAGE=memory|postgres`.

## Why

### The two providers do not make the same promise

This is the part worth reading twice, because it looks like a defect in the port
and is not.

| | memory | outbox |
| --- | --- | --- |
| publish reaches subscribers | ✅ | ✅ |
| at-least-once, dedupe by event id | ✅ | ✅ |
| a failing subscriber vetoes nothing | ✅ | ✅ |
| envelope and provenance round-trip | ✅ | ✅ |
| **survives process death** | ❌ | ✅ |
| **atomic with the caller's write** | ❌ | ✅ |

The memory bus publishes in-process: if the process dies between the write and
the dispatch, **the event is gone**. The outbox writes the event row inside the
caller's transaction, so publishing is atomic with the data write and a relay
dispatches afterwards — which is the entire reason it exists and something the
memory bus structurally cannot provide.

So `eventstest` asserts **what they share**, and stops. Contorting it to make
the two look identical would assert a promise one provider does not make, and
the first person to rely on that promise would be relying on the suite rather
than the provider. The difference is recorded here instead. That is the trade:
the note carries what the test cannot.

### The memory bus is not a testing convenience

It is what makes invariant **I1** possible. `make dev` and `make test` run the
whole application with zero external dependencies, and an outbox needs Postgres.
`STORAGE=memory` with `EVENTS_PROVIDER=memory` boots the real application,
publishes real events and runs real subscribers against nothing at all.

### A subscriber derives, it never mints

`../PROVENANCE.md` §4, and the one that is expensive to discover late. Consuming
an event, a subscriber takes **correlation from the envelope**, **causation from
the event id**, and a fresh request id.

```ts
events.provenanceFor(env)  ===  env.provenance.derive(env.id)
```

If a subscriber mints instead, the causal chain breaks at **every context
boundary** and the audit and lineage graphs disconnect — conformance case 38,
and the failure invariant `I6` exists to prevent. It is silent: every individual
record looks fine, and only the joins are missing.

The convenience lives **here, at L2**, as one line over the L1 primitive.
`provenance` is L1 and cannot import an envelope — `S1` forbids it permanently.
§4 also argues it is the better shape regardless: a broker consumer, a `work`
task and a webhook redelivery all derive from *parent plus cause*, and an
envelope is one carrier of that rather than the shape of the operation.

### The envelope constructor is rule M5

`M5`'s detect clause is the design: *publish goes through the envelope
constructor, which requires them.* So `Envelope.seal` takes `Provenance` as a
**required parameter** — not an optional field filled in later, and not read
from the ambient carrier.

That is what makes the rule enforceable at all. *"Publish goes through a
constructor that requires provenance"* is checkable; *"hopefully the context had
it"* is not.

### Dedupe must not swallow a retry

The subtle one, and nobody specified it — it came out of running the suite
against both providers.

An idempotent consumer must dedupe a **redelivery** without also suppressing a
legitimate **retry** after a failure. Get it wrong and a failed handler never
runs again: the write succeeded, the event was published, and one subscriber
simply never happened. Silent, and invisible in every test that only checks the
happy path.

The rule that makes it work is one line in both providers — **the dedupe record
is written only on success.** A subscriber that threw has not handled the event.

Both halves have to be asserted together, because each alone passes against a
different broken implementation: recording the dedupe unconditionally passes
*"the second delivery is a no-op"*, and never recording it passes *"the failed
one runs again"*. Confirmed by breaking each way and watching exactly the
expected case go red.

### Never claim exactly-once

At-least-once is the contract. The honest test delivers the same event **twice
on purpose** and asserts the second is a no-op — not that a duplicate never
arrives. Dedupe is keyed `(subscriber, event)`, because two subscribers must
each get their own delivery and one succeeding must not rob the other of it.

### What the outbox owes

- **Enqueue in the caller's transaction.** The writer takes the same `DB` the
  repository took, not its own pool. Defaulting to the pool would silently give
  back the dual-write problem this provider removes.
- **Claim with a lease** — `for update skip locked`, so N relays run without
  coordinating: each takes rows the others have not, and none waits.
- **Back off on failure**, with full jitter, because a relay is the worst place
  for synchronised retries.
- **Dead-letter rather than drop.** An event nobody can handle is still evidence
  that it happened, and deleting it destroys the only record of a failure
  somebody has to investigate.

### Two clocks, deliberately apart

`next_attempt_at` is **backoff** — when the row is eligible again.
`lease_until` is **ownership** — how long the claiming relay may hold it.

Collapsing them into one column is the bug that makes a slow consumer look like
a dead one: a long dispatch would extend the retry delay, or a backoff would
read as an expired lease and hand the row to a second relay while the first is
still working.

### What is not a provider

**Redis.** Pub/sub is fire-and-forget with no replay; Streams would work and
nothing requires it; and `../INFRASTRUCTURE.md` §4 has Redis backing `cache` and
`ratelimit` only. Rule 7: a service nothing tests against is dead weight.

The candidate third provider is a **real broker** — NATS or Kafka.
`../MODULES.md` §10 already retired v1's `events/remote` with the reason: build
it when a template needs it, not speculatively. When one does, it joins by
passing `eventstest` **and by nothing else** — and it would be the first real
evidence for the extraction claim in `../ARCHITECTURE.md` §9, which is still
marked NOT VERIFIED.

## Example

```ts
// Publishing, inside the write it belongs to.
await db.withinTx(async (tx) => {
  const user = await users(tx).create(input);
  await events.publish(unwrap(event('identity.user.registered', {
    user_id: user.id,          // primitives only
  })), provenance, tx);        // <- the caller's transaction
});

// Subscribing, deriving rather than minting.
events.subscribe({
  name: 'audit',
  pattern: 'identity.*',
  handle: async (env) => {
    await audit.record(env, provenanceFor(env));
  },
});
```

## Gotchas

**A relay nobody starts is a queue.** `dispatcher.drain()` had a contract suite
and it passed, because the suite called it. Nothing in the running process did.
Every event published in Postgres mode went into `event_outbox` and stayed
there, and the symptom was not an error anywhere — it was an audit log that was
simply empty, in a process where every request answered 200.

`start()`/`stop()` were already **declared** on the `Dispatcher` port and
unimplemented, which is the shape of the bug: a port whose optional method
nobody supplies looks identical to one nobody needs. The outbox now implements
them as a polling loop, and `main.ts` registers it as a `lifecycle` component
ahead of the HTTP server — so reverse-order shutdown stops accepting requests
first, then drains what the last of them produced.

Polling rather than `listen`/`notify`: a notification is lost if nobody is
connected when it fires, so a relay built on it alone silently stops after a
reconnect. `listen` could only ever be a latency optimisation on top of the
poll, never a replacement for it.

**Delivery is eventual, and a test that forgets this is a test that passes in
memory and fails against Postgres.** The memory provider runs a subscriber
inside the publishing transaction; the outbox delivers a moment later. That
difference is the price of atomicity between the write and the event, and it is
worth paying — but a journey asserting on an audit record immediately after the
request that caused it has to wait for the condition rather than assume it.

- **Payloads carry primitives only.** A payload crosses a process boundary, is
  stored for the life of an audit record, and is read by code compiled against a
  different version. A `Date` serializes three ways and a class instance
  serializes to `{}`.
- **`publish` takes the caller's `DB` and the memory bus ignores it.** Honest
  rather than sloppy: it has nothing to make atomic.
- **A subscriber name is required and must be stable.** At-least-once means a
  subscriber is identified by something that survives a restart; an anonymous
  handler cannot dedupe.
- **The dedupe row is written only on success.** A subscriber that threw has not
  handled the event and must see it again — while the one beside it that
  succeeded must not. See the section above; this is the property most likely to
  be half-implemented.
- **Redelivering against the outbox means two different things**, and a test
  harness has to do both: re-insert a row whose delete was lost, *and* make an
  eligible row that is still sitting in backoff after a failure. Doing only the
  insert silently no-ops against a row that is still there, so nothing is
  redelivered and the test passes for the wrong reason.
- **`Envelope.fromWire` takes a mint function and returns a `Result`.** A
  restored envelope must still be able to *derive*, and the bytes came from
  outside the process.
- **The claimable index is not partial.** The obvious predicate uses `now()`,
  and PostgreSQL refuses it — `now()` is `STABLE`, not `IMMUTABLE`, so it cannot
  appear in an index predicate. `42P17`, and it was caught the first time the
  migration ran against a real database and by nothing before that.
- **Claim and dispatch are separate transactions.** Holding one open across a
  subscriber's work would put an arbitrary handler inside the database's
  `idle_in_transaction_session_timeout`.
- **The memory bus dedupes too, in-process.** Lost on restart, which is
  consistent with the rest of its promise. The contract requires dedupe of every
  provider, so it is not optional here — and removing it turns the
  at-least-once case red, which is how I know that case is not tautological.

## Used in

- `src/shared/events/index.ts`
- `src/shared/events/outbox/index.ts`

This list grows to every context: `identity` publishes, `audit` subscribes to
everything, and `lineage` reads the causal graph the derive rule keeps
connected.

## Related

[[provenance]] — the derive-not-mint rule, and the L1 primitive this wraps for
envelopes. [[postgres]] — the outbox writes through the caller's `DB`, which is
what makes it atomic. [[errors]] — a failing subscriber's `Kind` reaches the
dead letter. [[retry]] — the same full-jitter backoff, for the same reason.
[[digest]] — an envelope is canonicalizable, which is what lets `audit` hash
one. [[clock]] and [[random]] — injected, so a relay's backoff is testable.
