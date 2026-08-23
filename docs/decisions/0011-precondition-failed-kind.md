# ADR 0011 — `precondition_failed` is a twelfth `Kind`, proposed not decided

**Status:** Proposed · **Date:** 2026-08-23

## Context

`../CONFORMANCE.md` case 29 requires that *a mutating request carrying a stale
`If-Match` is 412*. Case 3's status table maps eleven `Kind` values to eleven
statuses, and **412 is not among them**.

That is the same contradiction collection decision 0010 resolved for 422: one
case requires a status the table cannot produce. It was found the same way, by
implementing the module that needs it.

The gap is not cosmetic. `conditional` sits at position 9, below the problem
mapper at position 3, so a failed precondition leaves as a thrown error and the
mapper renders it. With no `Kind` that maps to 412, there are three options and
all of them are worse than a new value:

- **Reuse `Conflict`** and answer 409. Fails case 29 by name, and tells a client
  the wrong thing: 409 means *your write cannot be applied to the current
  state*, while 412 means *the state you asserted is not the state that is
  here*. The caller's next move differs — retry versus re-read and re-decide.
- **Let the middleware build the 412 response itself.** Needs no kernel change
  at all, and puts a second RFC 9457 body in the process, which the chain's
  shape exists to prevent.
- **Carry the status on the error.** Rejected by decision 0010 on reasoning this
  repository already accepted: a status a caller can attach makes the mapper's
  table advisory rather than total, and *mapped in exactly one place* stops
  being a property.

## Decision

**Add `precondition_failed` → 412, and mark this `Proposed` rather than
`Accepted`.**

The vocabulary is collection-wide — `err_kind` filtered across blueprints is
filtering one vocabulary or none — so a repository is not entitled to settle it
alone. This is the posture ADR 0006 took for `timeout` and `canceled`, and
decision 0010 explicitly rewarded it: *"right about the gap and right to
escalate rather than decide locally."*

Meanwhile this repository implements the value, so `conditional` works and case
29 passes for the right reason. If the collection rules otherwise, this ADR is
superseded rather than edited (`D3`).

## Alternatives considered

- **Ship `conditional` without a 412 and wait.** Rejected: the module's central
  guarantee is `If-Match`, and a `conditional` that cannot refuse is a
  `conditional` that does nothing. Waiting would also mean the first context
  ships against a module with a hole in it, which is the retrofit the `↑`
  promotion in `../MODULES.md` exists to avoid.
- **Fold it into `Conflict` and distinguish by problem `type`.** The same
  alternative decision 0010 rejected for 422, for the same reason: a client
  branching on status alone cannot tell *retry* from *re-read*, and both are
  common client behaviours that the status code is supposed to select between.
- **Wait for the collection before writing any code.** Rejected as a process:
  the work is not blocked, and an ADR is how the question stays visible. This is
  the second time this exact class of gap has appeared — a conformance case
  requiring a status the `Kind` table has no member for — which is itself worth
  raising alongside the value.

## Consequences

- The vocabulary is twelve here and eleven in the collection, and `err_kind`
  carries a value other blueprints do not emit. That is the honest state and
  should not be papered over.
- The `Record<Kind, number>` table stays total by construction, so the mapping
  gained a row and nothing else changed.
- If the collection accepts it, `../CONFORMANCE.md` case 3's table gains a row
  and case 50's constrained set becomes twelve.
- If the collection rejects it, this repository has to choose between failing
  case 29 and building a second error-body site. Recording that now is the point
  of raising it now.

## Verification

`src/shared/errors/index.test.ts` pins the vocabulary — the exact twelve values
— so a change to the set fails.

`src/shared/httpx/index.test.ts` asserts the status table is **total** over
every kind with no duplicate statuses, and that `precondition_failed` is 412.

`src/shared/conditional/index.test.ts` asserts case 29 end to end: a stale
`If-Match` on a PUT produces a 412 with an RFC 9457 body, built by the same
mapper as every other error and carrying the same request id.

## Enforced by

Nothing structural. `../ENFORCEMENT.md` has no rule id for the error vocabulary,
so none is cited and none is invented — the same position ADR 0006 recorded, and
still the substance of the finding rather than a gap in this document.

The nearest mechanical control is the totality of `Record<Kind, number>`: adding
a kind without a status does not compile, so the mapper cannot silently fall
behind the vocabulary.
