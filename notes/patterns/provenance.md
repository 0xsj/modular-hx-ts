---
module: provenance
layer: L1
---

# Provenance

## What

Five fields that travel with every unit of work: **request**, **correlation**,
**causation**, **actor**, **tenant** — plus `traceparent`, which is
observability only and never hashed.

`makeOrigins(ids)` gives the five ways one is created. `derive(causedBy?)` is
the only way to get a child. `Carrier` carries it ambiently for the three
consumers that need it. The shape and the rules are specified in
`../../../PROVENANCE.md`, which is normative and binding across the collection.

## Why

### It is the join key, and one gap disconnects two graphs

`audit` records who did what, to which subject, in which request — and it
imports no context, so provenance is the only thing tying its rows to anything
else. `lineage` builds a derivation graph, and causation is what makes the edges
connect. `../ARCHITECTURE.md` §4 is blunt: *"one gap disconnects both graphs."*

The failure mode is not "we cannot debug". It is **"we cannot answer a question
we are contractually required to answer"**, discovered during the audit rather
than before it.

### Why five fields and not fewer

Each collapse loses something specific.

- **Merge request into correlation** and the original attempt is
  indistinguishable from its retry.
- **Merge causation into correlation** and the *edges* are gone. Correlation is
  the set of everything that happened because someone clicked a button;
  causation is which thing caused which. That difference is the difference
  between a log and a graph.
- **Drop tenant** and it stops being observability and becomes security: rule
  `M3` scopes every repository query by it.

### Ambient to observe, explicit to stamp

The rule, in one line: **read ambient at a boundary, pass explicit across one.**

`logger`, `httpclient` and `telemetry` read ambiently, because threading
provenance through every log call is noise and those three cannot forget.
Anything producing an artifact that outlives the request — an event envelope, an
audit row, an attestation — takes it **explicitly**, which is what makes rule
`M5` enforceable: *"publish goes through a constructor that requires
provenance"* is checkable, *"hopefully the context had it"* is not.

**This is not the ambient-state rule `authz` follows, and the difference is the
point.** A `Subject` is a decision input: read ambiently, a forgotten
authorization check looks identical to a passed one — silent, and a security
failure. **Nothing branches on provenance.** A missing correlation id degrades
observability and grants nothing. Different failure modes, different rules.

`domain/` never sees it at all — rule `S7` already forbids it.

## Example

```ts
// Transport: mint, adopt what may be adopted, put it in scope.
const p = origins.forRequest({
  correlationId: headers['x-correlation-id'],
  traceparent: headers['traceparent'],
});
return Carrier.run(p.withActor(authenticated), () => handler(req));

// Application: read once at the top, pass explicitly onward.
const provenance = Carrier.require();
await repository.save(user, provenance);

// A subscriber derives — it is not a root.
const child = envelope.provenance.derive(envelope.id);
```

## Gotchas

- **A subscriber is not a root.** It takes correlation from the envelope,
  causation from the **event id**, and a fresh request id. Minting instead
  breaks the chain at every context boundary — precisely what invariant I6
  exists to prevent, and what conformance case 38 checks.
- **`derive` is the only way to get a child.** Hand-building one is how a
  parent's request id becomes the child's, collapsing the graph into a
  self-loop. No constructor permits it, and `createProvenance` is not exported
  from the module root.
- **The derivation primitive takes `causedBy`, not an envelope.** `provenance`
  is L1 and `events` is L2, so an envelope parameter would be a permanent
  upward import. It is also the better shape: a broker consumer, a `work` task
  and a webhook redelivery all derive from *parent plus cause*.
- **Adopt what can only correlate; mint anything conferring identity.**
  Correlation, causation and `traceparent` are adopted; **request id, actor and
  tenant never are**. Adopting an actor is an authentication bypass. Those three
  are absent from `InboundHeaders` entirely, so there is nothing to be tempted
  by.
- **An invalid adopted value is dropped, never a request failure.** Provenance
  grants nothing, so strictness is free: rejecting a malformed correlation id
  costs a broken trace link, accepting one costs log injection.
- **Absent fields are omitted, never `null`.** Under RFC 8785 those are
  different documents with different digests, so `null` would break parity
  between languages silently. `exactOptionalPropertyTypes` and [[digest]]'s
  refusal to accept `undefined` catch this twice.
- **`traceparent` is never hashed or signed.** It changes per trace, so
  including it would give the same logical action a different digest every time
   — destroying deduplication and any use of a digest as an idempotency key.
- **[[digest]] will not canonicalize a `Provenance` directly.** It refuses class
  instances rather than honouring `toJSON`, and that is deliberate: Go and
  Python have no implicit equivalent, so an explicit `.toJSON()` at the stamp
  point is what keeps the languages in step.
- **`current()` never throws; `require()` raises `Internal`.** A log line must
  never crash. A stamp point without provenance is a programmer error.
- **`Actor.onBehalfOf` is recursive and uncapped.** Nothing populates it until
  `impersonation` lands in phase 2, and the canonical form is therefore
  unbounded in depth. Worth revisiting then; not worth inventing a limit now.

## Used in

- `src/shared/provenance/actor.ts`
- `src/shared/provenance/provenance.ts`
- `src/shared/provenance/origins.ts`
- `src/shared/provenance/carrier.ts`
- `src/shared/provenance/ids.ts`
- `src/shared/provenance/index.ts`

This list grows to `logger`, `httpclient`, `telemetry`, the `events` envelope
constructor, and every `audit` row.

## Related

[[id]] — mints the request id through its port; adopted values stay opaque
strings, because an upstream service cannot be required to emit UUIDv7.
[[digest]] — the canonical form, and why absent must not become `null`.
[[errors]] and [[result]] — how a malformed stored record is refused.
[[brand]] and [[redact]] — the same shape of guarantee: what the type refuses to
let you do is the point.
