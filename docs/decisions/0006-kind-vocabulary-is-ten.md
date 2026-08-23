# ADR 0006 — The `Kind` vocabulary is ten values, not eight

**Status:** Superseded · **Date:** 2026-08-22

> Superseded by collection decision 0010, which makes the vocabulary eleven.
> The body below is left exactly as written (`D3`): it was right about the gap
> and right to escalate rather than decide locally, and it could not have known
> about the third value. See ADR 0010 in `../decisions/`.

## Context

`../CONFORMANCE.md` case 50 requires that `err_kind` *"is one of the eight
`Kind` values — never a free-form string"*. Case 3 gives the eight by way of a
status mapping: invalid → 400, unauthenticated → 401, forbidden → 403, not
found → 404, conflict → 409, **rate limited** → 429, unavailable → 503,
internal → 500.

`src/shared/errors/index.ts` defines **ten**:

```
ours (10): invalid unauthenticated forbidden not_found conflict
           exhausted unavailable timeout canceled internal
case 3 (8): invalid unauthenticated forbidden not_found conflict
           "rate limited" unavailable internal
```

Two separate discrepancies sit inside that one difference, and they are not the
same kind of problem.

**`exhausted` versus "rate limited"** is probably one kind under two names.
Case 3 is prose about status mapping rather than a normative enumeration, so
this may be wording. But case 54 makes field *names* byte-identical across
blueprints for exactly the drift-detection reason, and the same argument applies
to the *values* of a closed taxonomy: a dashboard filtering `err_kind=exhausted`
against one blueprint and `err_kind=rate_limited` against another is the failure
the profile exists to catch.

**`timeout` and `canceled` are genuinely extra, and load-bearing.** They are not
decoration:

- `errors.isRetryable` is true for exactly `unavailable` **and `timeout`**.
  `breaker` reads the same decision. Folding `timeout` into `unavailable` loses
  the distinction between *the dependency said no* and *we gave up waiting* —
  which is the distinction that decides whether retrying is repair or
  amplification.
- `canceled` is how an aborted request is told apart from a failure. `retry`
  relies on it to **stop** rather than back off and try harder, and a client
  that hung up is the case where retrying is purest waste.

Removing either does not simplify a taxonomy; it deletes a decision input from
three modules and replaces it with a heuristic.

This divergence has been known since the logger landed. Until now it was
recorded only in `STATUS.md`, **which is gitignored** — so the single record of a
deliberate deviation from a normative document was invisible to every reader of
this repository and to the collection. That is precisely the failure `D6`
describes, and it is the immediate reason this ADR exists.

## Decision

**Keep ten, unchanged, and record the deviation rather than resolve it here.**

Status is `Proposed`, not `Accepted`, on purpose: this is a **collection-level**
decision, because it changes resilience semantics in `retry`, `breaker` and the
eventual `httpx` status mapping in every sibling. This repository is not
entitled to settle it alone, and an `Accepted` status would claim it had.

What this repository commits to meanwhile:

- `err_kind` always carries a `Kind` and is **never** a free-form string, so
  case 50 holds **structurally**. It is the count that does not match, not the
  discipline.
- The status mapping of case 3 is honoured for all eight kinds it names, and
  `timeout` and `canceled` map to 504 and 499 respectively when `httpx` lands —
  neither invents a status for a kind case 3 covers.
- If the collection rules that eight is normative, this repository drops
  `timeout` and `canceled` and folds them into `unavailable` and `canceled` →
  `invalid`, and this ADR is superseded rather than edited (`D3`).

## Alternatives considered

- **Drop to eight now, to match case 50 exactly.** The obedient choice, and the
  one that makes the conformance suite green by definition. Rejected: it removes
  the input `isRetryable` is built on and would make `retry` and `breaker` worse
  in a way no test in this repository would catch, in service of a count in a
  document that may itself be the thing that is wrong.
- **Rename `exhausted` to `rate_limited` and keep ten.** Tempting, and it closes
  half the gap cheaply. Rejected as a partial move that would make the remaining
  divergence *look* resolved — the count would still be ten, and the next reader
  would have less reason to ask.
- **Emit only the eight in `err_kind` while keeping ten internally**, mapping
  `timeout` → `unavailable` and `canceled` → `invalid` on the way out. Rejected,
  and it is the worst option: the log line would then disagree with the
  program's own behaviour, so an operator seeing `err_kind=unavailable` could
  not tell whether the retry that followed was correct.
- **Raise it as a collection change and block until answered.** Rejected as a
  process for *this* file — the work is not blocked, and this ADR is how the
  question stays visible. Raising it remains the right next step.

## Consequences

- The conformance runner may report case 50 as failing on a count while every
  behaviour it checks is correct. That is the honest state and should not be
  papered over.
- Cross-blueprint dashboards on `err_kind` will see two values here that other
  blueprints do not emit. `exhausted` versus `rate limited` is the one that will
  bite first, because it is the same concept under two spellings.
- If the collection resolves in favour of ten, `../CONFORMANCE.md` case 50 needs
  restating and case 3's table extends to cover 504 and 499.
- This repository has no mechanical rule preventing the vocabulary from growing
  again. `Kind` is a closed `const` object and adding to it is a visible diff,
  which is the current control.

## Verification

`src/shared/errors/index.test.ts` pins the vocabulary — the exact ten values,
and that `isRetryable` is true for `unavailable` and `timeout` and nothing else.
A change to either fails.

`src/shared/logger/logger.contract.ts` verifies the structural half of case 50
across all three adapters: an error's `Kind` is promoted to `err_kind`, and it
is always a `Kind`.

**The count itself is not verified against `../CONFORMANCE.md`,** and cannot be
from inside this repository — that is the discrepancy, not an oversight. The
collection's fixture mechanism is where it would be caught, the same way
`../conformance/fixtures/canonical-json.json` catches a canonicalisation
disagreement. A `Kind`-vocabulary fixture would settle this ADR mechanically and
does not exist yet.

## Enforced by

Nothing structural, and that is the substance of the finding rather than a gap
in this document. `../ENFORCEMENT.md` has no rule id for the error vocabulary,
so none is cited and none is invented.

The nearest mechanical control is the conformance profile in
`../CONFORMANCE.md` §4.13, which requires the optional log-stream input and is
skipped rather than failed without it — so today it is not running against this
repository at all.
