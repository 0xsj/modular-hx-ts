# ADR 0010 — An anonymous caller with a key is a wiring error, and the cap spends the key

**Status:** Accepted · **Date:** 2026-08-23

Supersedes ADR 0009, on both halves.

## Context

ADR 0009 decided two things about `idempotency` and got both wrong, for
instructive reasons. Its 422 half is answered by **collection decision 0010**,
which added `unprocessable` to the `Kind` vocabulary rather than letting an
error carry a status. Its anonymous-caller half was wrong on its own terms, and
that is what this ADR is mostly about.

**The anonymous caller.** 0009 refused a request carrying an `Idempotency-Key`
from an unauthenticated caller with **400**, reasoning that the scope specified
by `../MODULES.md` §5 — key plus tenant plus principal — cannot be built without
a principal, so failing closed means refusing.

The underlying problem it identified is real: two anonymous callers presenting
the same key string would replay each other's responses, and there is no safe
discriminator to fall back to. A peer address is one NAT from useless and makes
the scope depend on network topology rather than identity.

**But the refusal contradicts the chain.** Position 6 is authentication. A route
that required authentication has already refused an anonymous caller by the time
position 9 runs — so an anonymous caller reaching position 9 means the route is
**public**. Refusing there asserts something untrue about the endpoint while
breaking a client that did nothing worse than send a header.

The mistake was treating a fact about the *mount* as a fact about the *request*.

**The cap.** 0009 threw `internal` when a response was too large to store, which
turned a successful write into a 500, and — because the module releases a key on
a server fault — the retry would then re-execute and double-apply it. The
"keeps the claim" test passed only because the throw happened before the release
path could run, which is a coincidence of ordering rather than a design.

## Decision

**The anonymous pairing is refused where it is declared, at startup.**
`idempotency()` takes `anonymousCallers: 'refused' | 'permitted'` and throws on
`'permitted'`. For a composition root that builds the chain at boot, that is a
process that does not start rather than a request that fails.

**If an anonymous caller reaches the middleware anyway, the `Kind` is
`Internal`.** A route wired inconsistently with what it declared is our mistake,
not the caller's, and 500 is the honest thing to say about our mistake.

**Past the storage cap the response passes through, the failure is logged at
error level, and the key is marked consumed** — a fourth record state, distinct
from in-flight and from completed-with-a-response. A retry against a consumed
key gets `unprocessable`: definitive, because the work happened and the answer
is gone.

## Alternatives considered

- **401 for the anonymous caller** — 0009's answer in a different colour, and it
  makes the contradiction louder rather than quieter: 401 means *authenticate
  and try again*, on an endpoint that will never require it.
- **Ignore the header for anonymous callers.** Rejected in 0009 and still
  rejected: the request succeeds, the client believes it is protected, and a
  retry double-applies. But 0009 rejected it as *a runtime choice*, which was
  the wrong frame — the reason it is unacceptable is that the mount should never
  have existed, and only a startup check can say so.
- **Derive a discriminator for anonymous callers** — peer address, a
  fingerprint, a cookie. Rejected: each is either forgeable or unstable, and a
  scope that is sometimes right is worse than one that is refused, because the
  failure is a silent cross-caller replay rather than an error.
- **Release the key past the cap.** Rejected, and this is the whole point:
  releasing means the next retry re-executes and double-applies the write, which
  is the one thing this module exists to prevent. **Losing replay is a cost;
  losing the guarantee is a failure.**
- **Leave the claim in flight past the cap** rather than consuming it. Rejected
  as release with a delay: the lease expires and the retry re-executes, just
  later and with less to explain it.
- **Answer 409 for a consumed key.** Rejected: 409 in this module means *come
  back when the flight lands*, and there is no flight and nothing coming.
  `unprocessable` is the honest one — the request is understood, and it cannot
  be acted on.
- **Keep 0009's `details.unprocessable` marker** now that a `Kind` exists.
  Rejected on collection decision 0010's reasoning, which is better than the one
  0009 used: a status a caller can attach makes the mapper's table advisory, and
  *mapped in exactly one place* stops being a property and becomes a convention.

## Consequences

- `IdempotencyOptions` has a required field whose only accepted value is
  `'refused'`. That looks strange in isolation and is deliberate: it makes the
  claim explicit at the mount, where somebody can be wrong about it in a diff.
- A public endpoint cannot have idempotency here at all. That remains the
  correct outcome — the guarantee is meaningless without knowing who the caller
  is — but it is now a startup failure with a message rather than a 400 the
  client has to interpret.
- The record store gained a fourth state and a `consume` verb, which both
  adapters implement and the contract suite covers.
- ADR 0009's `UNPROCESSABLE` marker, `unprocessable()` helper and
  `statusForError` are removed from `httpx/problem.ts`; the table is a plain
  `Record<Kind, number>` again, and total by construction.

## Verification

`src/shared/idempotency/index.test.ts` asserts that constructing the middleware
with `anonymousCallers: 'permitted'` throws; that an anonymous caller reaching
it answers 500 with the handler never running; that a response past the cap is
returned with the failure logged; and that a retry against the spent key answers
422 without re-running the handler.

`src/shared/idempotency/idempotencytest.ts` covers the consumed state against
both adapters, including that it is not mistaken for a replay and that it
expires on the response clock rather than the lease.

`src/shared/httpx/index.test.ts` asserts the status table is total over all
eleven kinds with no duplicate statuses, which is the property that would have
been lost under 0009's design.

## Enforced by

Nothing structural for the mount check — it is a runtime invariant at
construction, which is the strongest thing available without a routing table,
and `httpx` deliberately does not own one.

`../ENFORCEMENT.md` has no rule id covering either half, so none is cited and
none is invented.
