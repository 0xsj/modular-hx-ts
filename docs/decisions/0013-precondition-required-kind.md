# ADR 0013 — `precondition_required` is a thirteenth `Kind`, proposed not decided

**Status:** Proposed · **Date:** 2026-08-25

> **Update, 2026-08-26.** `../CONFORMANCE.md` §3.5 now settles the *status*:
> *a loader or client that PATCHes without `If-Match` gets `428` and is wrong;
> the blueprint refusing it is right.* That resolves the wire contract and
> leaves this ADR's actual subject — whether `Kind` grows a thirteenth value or
> the collection reaches 428 some other way — still open. Proposed stands.

## Context

`../CONFORMANCE.md` §3.5 marks `PATCH /v1/users/{id}` **`If-Match` required**.
This repository has enforced that since the route was written, and refused a
request without one like this:

```ts
throw new AppError(Kind.Invalid, '…requires an If-Match header…', {
  problem: 'precondition-required',
});
```

`Kind.Invalid` is 400. The slug beside it is RFC 6585's name for a condition RFC
6585 gives its own status — **428 Precondition Required** — and the comment
justifying the mismatch said *the slug carries the distinction the status
cannot*. That was not true. The status can; the vocabulary had no value for it,
which is a different sentence and the honest one.

**It cost a round.** The conformance corpus loader PATCHes `status` after
creating a user, because registration only makes active ones. It sent no
`If-Match`, got a 400, and reported *creating the disabled account failed* —
which reads as a malformed body, and sent three blueprints looking at their
request shapes. 428 says *retry this conditionally*, which is the actual
instruction, and is the difference between a loader that can fix itself and one
that files a bug.

**The route declared 428 the whole time.** Its `replies` map lists it, with a
comment reading *which is why 428 is here*. `S11` proves that a route declares
every status its chain can **produce**, not that it produces every status it
declares — so a declaration can be aspirational and the rule stays green. The
one-directional half is the useful one and this is not an argument for the
other, but it is worth knowing that a declared status is a claim nothing checks.

## Decision

**Add `precondition_required` → 428, and mark this `Proposed`.**

This is ADR 0011's shape, one condition along, and 0011's reasoning transfers
without modification:

- **Reusing `Invalid`** — what this did — answers 400 and tells a caller their
  request was malformed when it was merely unconditional.
- **Reusing `PreconditionFailed`** answers 412 and tells a caller their
  validator is stale when they sent none. The three states are *no validator*,
  *stale validator*, and *current validator*, and only the middle one is 412.
- **Carrying the status on the error** is refused by decision 0010 for reasons
  this repository already accepted.

The vocabulary is collection-wide. A repository that adds a value alone forks
`err_kind`, so this is proposed here and settled upstream, exactly as 0011 is.

## Alternatives considered

**Keep `Invalid` and let the slug do the work.** What this was. It survived
because nothing on the wire ever showed the two disagreeing — until a client
that was not this repository's own test suite read the status and believed it.

**Widen `PreconditionFailed` to cover both.** One `Kind`, two conditions, and a
caller that must read the slug to know whether to re-read or to add a header.
That is the shape ADR 0011 rejected for `Conflict`, for the same reason.

**Make `If-Match` optional on the route.** The loader would then load and the
`Kind` would not be needed. Refused: §3.5 says *`If-Match` required*, so this
would be conforming less in order to fail less, and the caller it would help is
one write away from losing an update.

**Send a `428` the middleware builds directly**, bypassing the mapper. Rejected
by the chain's shape — a second RFC 9457 body in the process is exactly what
position 3 exists to prevent.

## Consequences

`Kind` now holds thirteen values in this repository: decision 0010's eleven,
0011's `precondition_failed`, and this. Both rule tests that pin the vocabulary
failed on the addition before either was edited — which is the property those
tests exist for, and the reason adding a `Kind` here is a deliberate act rather
than a diff nobody notices.

The status table stays total and injective: thirteen kinds, thirteen distinct
statuses.

**The near miss is worth naming.** The rule about declared statuses proves a
route declares every status its chain can **produce**; it does not prove a route
produces every status it declares. This route declared `428` while answering
`400`, and that rule stayed green throughout — correctly, on its own terms. A
declared status is a claim nothing checks, which is worth knowing before reading
a `replies` map as documentation.

## Verification

`src/shared/errors/index.test.ts` pins the vocabulary — the exact thirteen
values, written out rather than derived — so a change to the set fails.

`src/shared/httpx/index.test.ts` asserts the status table is **total** over every
kind with no duplicate statuses, and that `precondition_required` is 428.

Both of those failed on this change before either was edited, which is the
evidence that the pin is real rather than decorative.

## Enforced by

Nothing structural, and the same sentence ADR 0011 wrote applies here:
`../ENFORCEMENT.md` has no rule id for the error vocabulary, so none is cited and
none is invented.

