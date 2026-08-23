---
module: idempotency
layer: L4
---

# Idempotency

## What

Position 9 of the `httpx` chain. **Claim before running, replay stored responses
bit for bit, fail closed.**

```
claim(scopedKey, fingerprint) -> claimed | replay | mismatch | in-flight | consumed
```

A store behind a port with two adapters and one contract suite, a middleware
that fills the slot `httpx` left named and empty, and a table with two clocks in
two columns.

## Why

### The key is scoped, and this is the one to test directly

The lookup key is the client's `Idempotency-Key` **plus the tenant and the
authenticated principal**. A bare key is a cross-tenant read: a caller who
guesses another tenant's key gets that tenant's response body back, and neither
party can tell it happened.

Nothing else in the suite catches this. Every other case runs in one tenant,
where a global key behaves identically — so a test with two tenants and the same
key string is not thoroughness, it is the only place the defect is visible.

It is also why position 9 sits below authn and tenant. The order is not a
preference; the module **cannot build its own key** until those have run.

### An anonymous caller is a wiring error, not a client error

Two anonymous callers presenting the same key string would replay each other's
responses, and there is no safe discriminator to fall back to — a peer address
is one NAT from useless and makes the scope depend on network topology rather
than identity. So the pairing must not exist.

**But refusing the request contradicts the chain.** Position 6 is
authentication. A route that required it has already refused an anonymous caller
by the time position 9 runs, so an anonymous caller *reaching* position 9 means
the route is **public** — and answering 401 or 400 there asserts something
untrue about the endpoint while breaking a client that did nothing worse than
send a header.

The mistake the first version made was treating a fact about the **mount** as a
fact about the **request**. So the pairing is refused where it is declared:
`idempotency({ anonymousCallers: 'permitted' })` throws at construction, which
for a composition root means the process does not start. If an anonymous caller
reaches the middleware anyway, the `Kind` is `Internal` — a route wired
inconsistently with what it declared is our mistake, and 500 is the honest thing
to say about our mistake. See ADR 0010, which supersedes 0009.

### The fingerprint is over the canonical request

Not the raw bytes. A client whose JSON library orders keys differently between
attempts is making a *safe* retry, and raw bytes would turn it into case 26's
422 — the mechanism punishing the behaviour it exists to protect.

`digest` already canonicalizes under RFC 8785 and the collection already pins
those bytes, so this is reuse rather than new machinery: the same
canonicalization that makes an envelope digest comparable across languages makes
a request fingerprint comparable across retries.

Method and path are in the digest too. The same body posted to `/payments` and
to `/refunds` is not the same request, and a key reused across them should say
so.

### Two clocks, and what breaks if you merge them

| Clock | Governs | Expiry means |
| --- | --- | --- |
| `expiresAt` | how long a **completed** response stays replayable | forgotten; a retry executes afresh |
| `leaseUntil` | how long an **in-flight** claim is honoured | the claimant is presumed dead; reclaimable |

**A future reader will want to merge these**, so here is what each merge costs
rather than only the rule.

*Without the lease at all*, a process that dies between claiming and storing
leaves the key in flight forever. Case 27's 409 becomes **permanent** for that
key: a client is locked out of an operation it never completed, and only an
operator with table access can free it. The crash test is claim, never complete,
never release — the shape a dying process actually has from the store's side.

*Collapsed into one column*, one of two things happens and both are bad.
Completing a request either extends the single clock to the TTL — so a crashed
claim is now held for a day — or expires the response with the lease, and case
25 stops working thirty seconds after it starts. A completed key must outlive
the moment a crashed claim is released **by a wide margin**, which is the
definition of two different questions.

The same shape as the outbox relay's `next_attempt_at` and `lease_until`, and
the same reasoning: backoff and ownership are different questions, and a column
that answers both answers neither well.

### Release: two questions, not a status class

**This rule was wrong once, and how it was wrong is more useful than the rule.**

The first version was *5xx releases, 4xx holds*, justified as a 4xx being a
deterministic answer to a malformed request where replaying is correct. It held
up against every case anybody had written down — and then `conditional` landed
and produced a 4xx that is nothing of the sort.

The status class was never the real test. It was a **proxy** for one, and it
agreed with the real test until it didn't. The real test is two questions:

| | would re-execution answer the same? | did anything happen? | |
| --- | --- | --- | --- |
| server fault | **might differ** | **might have** | release |
| precondition failed | **will differ** | **definitely not** | release |
| invalid, unprocessable, not found, conflict | same every time | no | hold |
| canceled | might differ | **might have** | hold |

Case 28 is the first row: storing a transient failure freezes it for the whole
TTL, and a client that retries after an outage gets the outage replayed back at
it for a day.

**A 412 is the row that broke the old rule.** It is not deterministic — it
depends on server state, and a client that re-reads and sends a corrected
validator *should* get a different answer. Holding it strands a client who fixed
their request properly: they must invent a new key to make progress on a request
they already corrected, which is the opposite of what a key is for.

Releasing it is safe for a reason **specific to 412** rather than a loosening of
the rule: `conditional` sits *inside* this module at position 9 and throws
**before** calling `next`, so nothing executed and there is no write to
double-apply. The ordering is what makes that structural instead of a promise.
A handler throwing `preconditionFailed` inherits the obligation — the kind means
*the state you asserted is not the state that is here*, which asserts the write
did not apply.

**`canceled` is the row that shows the two questions are genuinely separate.**
It might differ on a retry, exactly like a server fault, and it is still held:
a client that hung up tells us nothing about whether the handler finished.

**The rule can now be "simplified" in two directions, and both are tested.**
Back to *release on any error* lets a client retry its way to a different
outcome. Back to *4xx holds* silently strands every client that corrects a
failed precondition — which is worse, because it looks like the rule working.

### The two cases that cross into `conditional`

Neither module's own suite can catch these: they need a precondition failure
produced by one module and a release decision taken by the other, and the wrong
answer looks right from inside either one. So they live beside the release rule
they belong to.

- **A retry after success replays**, even though the state has moved between the
  two calls. That is `conditional` running *inside* this module paying off — the
  original preconditions were evaluated once, when they meant something.
- **A retry with the same key and a corrected `If-Match` re-executes and
  succeeds.** The `If-Match` header is deliberately not part of the fingerprint
  — that covers method, path and canonical body — so correcting a validator is
  the *same request*, better informed, rather than a different one that would
  earn a 422.

### The store fails closed, and its neighbour fails open

Store unreachable is **503**, never "proceed without a claim". Executing
unclaimed double-applies the write the client asked to have protected, so the
availability trade is the whole point of the module rather than a compromise
inside it.

`ratelimit` lands in position 7 shortly and its default is the **opposite** —
limiter down means let the traffic through. A reader who sees both without the
reasoning will assume one is a mistake, so: `../RESILIENCE.md` §1 decides the
default by *category*. Security and data-integrity controls fail closed;
availability controls fail open. A throttle that fails open loses some
throttling and the edge is still behind a load balancer. A claim that fails open
loses the money.

**There is a second, quieter asymmetry inside this module**, and it looks like
an inconsistency until it is named. Failing closed at *claim* time prevents an
execution. Failing at *store* time — after the handler ran — would deny an
execution that already happened and whose writes are already durable, telling a
client its request failed when it succeeded. That is a worse lie than losing a
replay, so a `complete` that throws is reported and the response is returned.
The client's retry meets the claim, which is still held.

### Replay is marked, and only carries what the response owns

Status and body exactly as stored. Headers pass an **allowlist** on the way in:
`content-type`, `etag`, `location` and their neighbours are properties of the
representation, and everything else is dropped.

`set-cookie` is the one worth naming — per-session by definition, so a replayed
one hands a second caller the first caller's session. `date` and `x-request-id`
are the quieter version of the same error: a replayed request id points a
support conversation at a log line for somebody else's request.

An allowlist rather than a denylist, for the reason `provenance` uses one for
adoption: a header nobody thought about is dropped rather than replayed. The
cost of a wrongly-dropped header is a client that asks again; the cost of a
wrongly-kept one is a response that misdescribes itself.

**The replay still gets the current request's id**, because position 1 stamps it
on the way out and position 9 is below it. Position 9 storing nothing
per-request and position 1 adding this request's own is what makes a replay
honest rather than merely identical.

### The cap spends the key, and never releases it

Replay means buffering, which is what the late-error rule says not to do. The
two reconcile by **scope**: only a request carrying a key is buffered, and an
endpoint that streams must not accept one.

So exceeding the cap is a **wiring mistake**, not a runtime condition. Silently
declining to store is the failure mode — the request succeeds, the client
believes it is protected, and the guarantee is gone with nothing anywhere saying
so. It goes to the log at error level, naming the endpoint, the size and the cap.

**The response passes through.** It is a real answer to a real request, and
turning it into a 500 would tell the client its write failed when it did not.

**And the key is consumed, never released.** Releasing means the next retry
re-executes and double-applies the write, which is the one thing this module
exists to prevent: *losing replay is a cost, losing the guarantee is a failure.*
Leaving the claim in flight is release with a delay — the lease expires and the
retry re-executes, just later. So the record moves to a fourth state, and a
retry against it is answered **definitively**: `unprocessable`, because the work
happened and the answer is gone. 409 would promise a reply that is never coming.

### What a real database found that nothing else could

The claim must be atomic, and the PostgreSQL adapter buys that with an upsert:
`insert ... on conflict do update ... where` takes the key when nobody holds it
and takes it back when the existing row is dead. Read-then-write is the defect
the port exists to prevent, and it passes every single-threaded test.

Sixteen concurrent claims against a real PostgreSQL produced **three** winners
on the first run. The cause was not the upsert — it was the branch that read
"the follow-up select returned nothing, so nobody holds it".

`on conflict` re-checks against the **latest** row version. The plain select
beside it in the same statement keeps the snapshot taken when the statement
began. So a claimant that blocks on somebody else's uncommitted insert wakes to
an insert that correctly conflicts and a select that correctly finds nothing.
Empty means *something blocked us that we cannot see* — never *the key is free*.

Two changes came out of it: a second read on a fresh snapshot, which turns the
ambiguous case into the true answer rather than a defensive 409, and a
fail-closed fallback if even that finds nothing. The in-process suite could not
have found either: there the claim is atomic because JavaScript runs it to
completion, and there is only ever one snapshot.

### The response-writer trap has no analogue here, and that is worth stating

In a language where a handler writes to a response writer, capturing a response
for replay means wrapping that writer — and a wrapper that forgets the flush,
hijack and efficient-copy interfaces disables streaming on every endpoint the
chain touches, invisibly to any test asserting only status and body.

There is no wrapper here. The `Handler` in the L4 floor returns a `Response`
value whose body is already a buffered string, so there is no writer to wrap and
no streaming interface to lose. **The rule that an endpoint which streams must
not accept a key is currently enforced by the chain's shape rather than by this
module** — nothing behind this chain can stream at all. If `httpx` grows a
streaming response, that rule becomes this module's to enforce, and the
committed-tracking writer belongs in [[edge]] alongside the types.

## Example

```ts
const records = postgresRecords(db, { ttl: hours(24), leaseFor: seconds(30) });

const handler = chain(
  {
    clock,
    origins,
    telemetry,
    authenticate,
    resolveTenant,
    // The slot was named and empty. This is the wiring, in full.
    idempotency: idempotency({ records, reporter: logger }),
  },
  route,
);
```

## Gotchas

- **A key on a safe method is ignored, not refused.** A client library that
  attaches the header to every request is being harmlessly thorough, and there
  is no state to protect.
- **An empty key is refused rather than treated as absent.** A client that sent
  the header meant to be protected, and silently not protecting it is the
  failure mode this module has the least excuse for.
- **A mismatch is reported ahead of an in-flight claim.** Told 409, a client
  with a changed payload retries and gets 422 anyway, one round trip later.
- **422 is its own `Kind`, not a refinement of `Invalid`.** Collection decision
  0010 added `unprocessable`, and the distinction is the one HTTP draws:
  `invalid` means the request could not be *understood*, `unprocessable` means it
  was understood and refused. Case 26 is the type specimen — the key and the
  payload are each perfectly well-formed, and it is their disagreement that
  cannot be acted on. This module briefly carried a status marker on the error
  instead; see ADR 0010, which supersedes 0009.
- **A thrown error is never stored**, because position 9 sits below the problem
  mapper and never sees the rendered body. Its `Kind` decides release-or-hold
  and nothing else. A handler that *returns* a 4xx gives this module something
  to store, and that one replays bit for bit. This is the chain-order
  consequence still open with the collection — see **Used in** below.
- **A replayed problem body would carry the wrong `instance`.** That is the
  quiet reason the stored headers are the response's own and never the request's,
  and it generalises past headers: `instance` is the request id, so a stored
  problem document says *which request produced it*, and a replay of it says
  that about a request that is not the one being answered. Re-rendering at
  replay time would give the client the id of the request it is actually making
  — which is exactly right, and exactly what this module cannot do from below
  position 3.
- **The fail-closed fallback in the PostgreSQL adapter has no test**, and that
  is recorded rather than hidden: reaching it needs another session to delete
  the row between two statements of one function, which nothing outside the
  function can schedule.
- **`purge` is a `jobs` step, not a request-path one**, and nothing schedules it
  yet. It drops completed records past their TTL and deliberately leaves
  in-flight ones alone — an expired lease means *reclaimable*, not *garbage*,
  and purging one would erase the evidence that a claimant went missing.
- **The contract suite waits on real time.** One of the two clocks lives inside
  PostgreSQL as `now()`, where no injected clock reaches, so a suite that faked
  time would assert the memory adapter's arithmetic twice and the thing that
  matters never.

## Used in

- `src/shared/idempotency/index.ts`

Every mutating endpoint that accepts an `Idempotency-Key` sits behind it, which
in practice means every context with a create or a charge. The composition root
wires one store and one middleware.

**One question is open with the collection, and it is a consequence of the
specified order rather than a choice made here.** Position 9 sits below the
problem mapper at position 3, so a *thrown* error never reaches this module as a
rendered response — only as a `Kind`. That is fine for release-or-hold, and it
means `hold on 4xx` cannot deliver a bit-for-bit replay: the second caller gets
409 until the lease, then a deterministic re-execution to the same answer.

Rendering it here would fix that and cost more than it is worth. `problemFor` is
deterministic, so position 9 could call it — but the document contains
`instance`, which is the request id, and storing one means a replay tells the
client the id of a request that is not theirs. Re-rendering at replay time gives
them their own id and is exactly right, and is also a second place that builds
an error body, which is what the chain's shape exists to prevent.

## Related

[[edge]] — the L4 floor this imports instead of `httpx`, and why the floor
exists. [[httpx]] — position 9, and the slot it fills. [[digest]] — the canonical fingerprint, and why it is not raw
bytes. [[tenant]] — the fence the scoped key extends into the replay cache.
[[provenance]] — where the principal and tenant come from, and why the order is
a precondition rather than a preference. [[events]] — the outbox's two clocks,
which are the same idea under different names. [[postgres]] — the upsert, the
snapshot, and `asAppError`. [[errors]] — the `Kind` the status decision reads.
