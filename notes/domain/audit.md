---
context: audit
---

# Audit

## What

Append-only. Subscribes to **every** context's domain events and records who did
what, to which subject, when, in which request and trace. One aggregate, one
subscriber, one read endpoint.

Conformance cases 35–38, and it is the proof that the event plumbing works end
to end.

## Why

### It imports nothing, and that is the property rather than a constraint

Rule `S6` forbids a context importing another. For most contexts that is a
boundary to respect; for `audit` it is **the thing being demonstrated**. The
whole point of the context is that a complete record of what happened can be
built from events alone — so if it ever needs an import, the events are wrong.

That has a concrete consequence in the code: `subject` is a bare id, because
there is nothing here that could resolve it into a name. A reader wanting the
name is a reader telling you the *event* should carry it, and §2.5 is why it
already carries the id.

**Nothing was missing.** `identity`'s events all carried a subject and all
prefix-matched `identity.`, so building this context found no gaps in them —
which is the outcome the naming rules were for, and worth recording because the
alternative would have been the interesting finding.

### The first subscriber found a gap in `events`

`CONTEXTS.md` §3: *subscribes to **every** context's domain events*. The bus's
`matches` supported an exact name and a `<prefix>.*`, and **neither can express
that**. A bare `*` matched nothing.

The alternative — one subscription per context — is the version that looks fine
and rots: the list is correct until somebody adds a context and forgets, after
which that context's events are simply absent from the record that exists to be
the evidence, and nothing reports a gap.

So `events` gained `EVERYTHING`, with its own tests in the module that owns it.
A subscriber needing a pattern the bus cannot express is a bus problem, and
fixing it in `audit` — by enumerating — would have been the wrong repair.

### Derive, never mint — case 38

The audit record for an event produced by request X carries **X's** correlation
id. `provenanceFor(envelope)` is `envelope.provenance.derive(envelope.id)`: a
fresh request id for this unit of work, the envelope's correlation carried
through, and the envelope's id as the cause.

A subscriber calling `forJob` would mint a new correlation and **break the chain
at exactly the point `audit` exists to record**. The record would say *something
happened* with no way back to the request that caused it, and the failure is
invisible — every field is populated, and only the join is gone.

Two fields are deliberately different, and the pair is the whole of case 38:

- **`correlationId` is the derived one**, which is the envelope's, which is the
  originating request's.
- **`requestId` is the source's**, not the derived one. The derived provenance
  has a *new* request id because recording is a new unit of work, and the record
  needs the id a reader joins against an access log.

### Subject and actor differ, and the record must not assume otherwise

§2.5 puts the subject on the payload and the actor on the envelope precisely
because they differ: an administrator disabling somebody else, a challenge
consumed on behalf of a user, a job expiring a session. A record that assumed
them equal is wrong exactly when somebody is looking.

The test that matters is the administrator granting a role to somebody else —
`subject` is the target, `actor` is the administrator, and they are asserted to
be different rather than merely present.

### Idempotent by the *event's* id, not the record's

Delivery is at-least-once, so redelivery is normal traffic. Two consequences
that are easy to get half-right:

- **A duplicate is not an error.** A subscriber that threw on one would
  dead-letter its way through a perfectly healthy queue. `append` returns
  whether a row was added, which is what makes the property assertable.
- **The key is the event's id.** The subscriber mints a fresh *record* id per
  delivery, so keying on that stores every redelivery — and case 36 would pass
  only because nothing had redelivered yet. There is a contract case for exactly
  this.

### The scope ANDs; it is never a default the filter overrides

Case 37: a caller reads records where they are the actor **or** the subject, and
`admin` and `auditor` read everything. Two halves, and the second is the one
that matters — being disabled by an administrator is a record where somebody
else acted, and it is the record you most want to find.

The escalation this shape prevents: a caller narrowing to
`?subject=somebody-else` must still see nothing. That is only true because the
scope is a **separate argument the adapter ANDs in** rather than a default the
query could replace, and it has its own contract case.

**`audit` never names `admin` or `auditor`.** It asks `authz` for a `Reach` and
turns that into a scope; which roles reach how far is the composition root's
policy. This is also where `authz` is exercised across a context boundary for
the first time: a `Subject` built from identity's authenticated caller
authorizes a read in a context that has never heard of identity.

## Gotchas

- **`audit` does no authentication.** §3: the root lends it identity's bearer
  auth and hands the caller over as a `Subject`. The transport takes a `caller`
  function and never sees a token — which is how it can know who is asking
  without importing the context that knows what a token is.
- **This is the second copy of the route-registration shape**, because `S6`
  makes identity's unreachable. §8 names the trigger: *after the third context,
  this is `scaffold`'s job*, so the next one to need it is when copying stops
  being acceptable.
- **`nolint:tenant`, and `audit` is the one context where the rule inverts.**
  `M3` exists because an unscoped query returns other people's data. Here the
  table records events from every context including ones with no tenant at all —
  a boot, a migration, a job — and `where tenant = $1` would silently hide
  exactly the system actions an auditor is looking for. What protects a caller's
  records is `Scope`, which is per **caller** and therefore stricter.
- **`text_pattern_ops` on the prefix index.** The default opclass uses the
  database's collation and a `like 'identity.%'` will not use an index built
  with it — which turns every prefix search into a scan of the biggest table
  here, silently, and only once there is data in it. There is an integration
  test that asks the planner.
- **`escape '\'` is written out.** The default escape character is backslash on
  most builds and is not guaranteed; a pattern whose escapes are inert matches
  more than it says. The prefix is validated before it gets there too — belt and
  braces, because a prefix reaching `like` unescaped is how a filter becomes a
  scan of everything.
- **Absent is absent, in the column and on the wire.** Case 38a: the same
  logical record canonicalizes to identical bytes in every language, and a
  `null` and an omission are different documents under RFC 8785. `toWire` omits;
  the column is NULL rather than `''`.
- **There is no `save` and no `delete` on the port**, and their absence is the
  design. A port that could edit a record is one somebody eventually calls; the
  nearest thing to a correction is a second record saying so.

## Used in

- `src/contexts/audit/index.ts` — the context root, and the only way in.

Mounted by the composition root: `audit.subscription` on the bus,
`audit.handler` behind `httpx`'s chain with identity's authenticator at position
6, and `audit.migrations` in the migration set. Nothing else may reach it —
rules `S5` and `S6`.

## Related

[[events]] — the bus, the envelope, and the `EVERYTHING` pattern this context
needed. [[provenance]] — `derive` rather than mint, which is case 38 in one
method. [[authz]] — the `Reach` that becomes a scope, exercised across a context
boundary for the first time. [[postgres]] — the unique index that makes case 36
hold across processes. [[identity]] — the publisher, reached only through the
bus.
