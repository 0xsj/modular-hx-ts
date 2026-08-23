# ADR 0009 — 422 is a refinement of `Invalid`, and an anonymous caller may not use a key

**Status:** Superseded · **Date:** 2026-08-23

> Superseded by ADR 0010 in this repository, on both halves and within a day.
> The body is left exactly as written (`D3`). It found a real specification
> bug — case 26 required 422 and case 3's table had none — and reached for the
> cheapest local fix; collection decision 0010 answered the question properly
> with a new `Kind`. Its anonymous-caller half was wrong for a reason it never
> considered, which ADR 0010 records.

## Context

`idempotency` fills position 9 of the `httpx` chain, and building it forced two
questions that neither `../MODULES.md` §5 nor `../CONFORMANCE.md` answers.

**First, 422.** Conformance case 26 requires that *the same key with a different
payload is 422*. The `Kind` vocabulary has no member that maps to 422: `invalid`
is 400, and every other kind is further away. Case 3's status table does not
mention 422 either, so the requirement and the table it must be satisfied
through do not meet.

422 is not a synonym for 400 here. A reused idempotency key with a changed body
is syntactically well-formed and semantically wrong, which is exactly the
distinction RFC 4918 §11.2 draws and exactly what a client needs in order to
know that re-sending the same bytes will not help.

**Second, the anonymous caller.** `MODULES.md` §5 fixes the lookup key as the
client's key *plus the tenant and the authenticated principal*, and gives the
reason: a bare key is a cross-tenant read. It does not say what to do when there
is no authenticated principal, and the honest answer is that the scope specified
cannot be built.

## Decision

**422 is a documented refinement of `Invalid`, resolved in `problem.ts` and
nowhere else.** An `AppError` of kind `Invalid` may carry `details.unprocessable
= true`; the single mapping point reads it and answers 422, with
`type: /problems/unprocessable` and its own title. `unprocessable()` in
`httpx/problem.ts` is the only constructor, so the marker is not a convention
anybody has to remember.

**A request carrying an `Idempotency-Key` with no authenticated principal is
refused with 400**, and the handler does not run.

## Alternatives considered

**For 422:**

- **Add a `Kind`.** Rejected: the vocabulary is closed and collection-wide, and
  ADR 0006 already records that its size is not this repository's to settle. A
  tenth-and-a-half kind added unilaterally would make that conversation harder,
  not easier.
- **Return 400 and accept the divergence.** Rejected: it fails case 26 by name,
  and it tells a client to fix a request that has nothing wrong with it.
- **Let `idempotency` build its own problem response with status 422.**
  Rejected, and it is the tempting one: it needs no change to `httpx` at all.
  But it puts a second RFC 9457 body in the process, which is the thing the
  chain's shape exists to prevent — the mapper stops being *the* place error
  bodies come from and becomes *a* place.
- **A general `status` override on `AppError.details`.** Rejected as too much
  door for one need. A named marker with one constructor is refusable in review;
  an arbitrary status field is a status mapping scattered across every module
  that wants one, which is invariant `I7` inverted.

**For the anonymous caller:**

- **Scope by `anonymous:` and let it through.** Rejected. Every unauthenticated
  caller shares one namespace, so one caller's response replays to another's
  request — the same cross-caller read the tenant scoping exists to prevent,
  differing only in that nobody would think to look for it. It is a
  vulnerability that presents as a feature working.
- **Scope by the peer address.** Rejected: it is one NAT away from the previous
  option and one proxy away from being wrong, and it would make the scope depend
  on network topology rather than identity.
- **Ignore the header for anonymous callers.** Rejected as the worst of both:
  the request succeeds, the client believes it is protected, and a retry
  double-applies. A guarantee that silently is not given is worse than one
  refused.
- **Answer 401.** Rejected: whether an endpoint requires authentication is
  position 6's decision, and answering 401 from position 9 would have this
  module quietly changing the auth policy of every route it sits under.

## Consequences

- `err_kind` on a 422 reads `invalid`, which is correct — the refinement is a
  transport detail and the `Kind` is unchanged. A dashboard grouping by
  `err_kind` sees one bucket; one grouping by status sees two.
- The refinement is a precedent. A second one would be a second `if` in
  `problemFor`, and the table stops being a table. If a third appears, the right
  move is to raise the vocabulary question at collection level rather than to
  grow this mechanism.
- An endpoint that is public and wants idempotency has no path here. That is the
  correct outcome for now: it should first decide who its callers are, because
  the guarantee is meaningless without an answer.
- If the collection later specifies a `rate_limited`/`unprocessable` expansion of
  `Kind`, this ADR is superseded rather than edited (`D3`).

## Verification

`src/shared/idempotency/index.test.ts` asserts that a reused key with a changed
payload answers 422 with `type: /problems/unprocessable`, that an ordinary
`invalid` still answers 400 with `type: /problems/invalid`, and that a key from
an anonymous caller is refused 400 with the handler never running.

`src/shared/httpx/index.test.ts` pins the unrefined `Kind` → status table, so a
refinement that leaked into the general case fails there.

## Enforced by

Nothing structural. `../ENFORCEMENT.md` has no rule id for status mapping, so
none is cited and none is invented. The nearest control is the invariant that
errors become transport codes only in transport — which this decision keeps
rather than bends, by resolving the refinement inside the single mapping point
rather than beside it.

The mechanical guard that does exist is narrow and worth naming: `unprocessable`
is the only exported constructor for the marker, and `problemFor` is the only
reader, so a grep for `UNPROCESSABLE` finds every use in two files.
