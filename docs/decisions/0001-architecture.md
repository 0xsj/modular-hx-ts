# ADR 0001 — Architecture

**Status:** Accepted · **Date:** 2026-08-21

## Context

This repo is a blueprint in the `blueprints/` collection. The collection
specifies invariants (`ARCHITECTURE.md` Part I), a default style (Part II) and
per-style variations (Part III). An architecture is chosen once, recorded here,
and **everything it replaces is enumerated** — an unlisted deviation is a bug,
not a preference.

Language: **TypeScript** · Framework: **node:http + fastify (both, behind one port)** · Storage: **postgres**

## Decision

- **Modular monolith: hexagonal contexts over a layered shared kernel**
  (`../../ARCHITECTURE.md` Part II, adopted with **no deltas**).
- Light CQRS: commands go through the aggregate, queries return views, **same
  store**. A separate read store would need its own ADR.
- Domain events after commit, via an outbox when storage is real.
- Contexts never import each other.

**Part I invariants apply unchanged.** This repo is a blueprint, not a
counterpart (ADR 0008): it satisfies all four acceptance criteria with no
exemptions.

Scope is phase 1 of `../../MODULES.md`, enumerated in `docs/TREE.md`. Deferred
modules each carry a trigger.

## Alternatives considered

- **Vertical slice.** Rejected here — it is a counterpart (ADR 0008), built to
  argue with this repo rather than replace it.
- **Event sourcing.** Rejected here — it is the `modular-es-*` sibling. Shipping
  it in both would leave nothing to compare.
- **A framework-led structure.** Rejected: the architecture leads and the
  framework is quarantined. That is what `hx-<framework>` means (`GLOSSARY.md`).

## Consequences

- Phase 1 is ~36 modules before the first bounded context. That is the honest
  price of the four acceptance criteria, and why phases exist: v2.0 must **run**,
  not be complete.
- Every other blueprint is a delta against this one, so mistakes here propagate.
  Part III of the collection architecture is only true if this repo is right.
- The extraction path (Part II §9) remains **NOT VERIFIED**. This repo does not
  verify it and must not claim to.

## Enforced by

The architecture rules, in `.dependency-cruiser.cjs` — each names this ADR in
its comment, so the citation appears in the failure message:

`S1` · `S2` · `S3` · `S5` · `S6` · `S7` · `S8` · `S9` · `S10`

The semantic rules, in `tests/rules/semantic-rules.ts` — claims about what the
code does rather than what it imports, so they are parsed from the syntax tree:

`M2` · `M13` · `I5` · `M6` · `M9` · `M4` · `M3`

`I5` cites the invariant rather than an `M` number. `../ENFORCEMENT.md` has a
rule for the clock half of invariant I5 and none for the randomness half, and
the missing piece is the detection, not the rule — that document says a rule
with no detection method is only a guideline. Minting an `M` number locally
would put this repository's rule set out of step with its siblings, which is
exactly what rule D7 warns about for ADR numbers and what this blueprint's
thesis cannot afford. Invariant ids are Part I: identical everywhere, never
renumbered. The rule renames if `../ENFORCEMENT.md` gives it an id of its own.

The document rules, in `tests/rules/docs-rules.ts`. These are mandated by the
collection's ADR 0006 (`../decisions/0006-notes-and-adrs-enforced.md`) rather
than by this decision, and are named here because this repo is where they run:

`N1` · `N2` · `N3` · `N4` · `N5` · `N6` · `N7` · `D1` · `D2` · `D4` · `D5` ·
`D7` · `R3` · `R4` · `R6` · `R7`

Rules deliberately not enforced yet, and the three that cannot be mechanically
checked at all, are listed with their reasons in `docs/TREE.md` under *Rules not
yet enforced*. They are named there rather than here: a rule id inside this
section is a claim that something enforces it.

*(Added after acceptance. Rule D3 makes an accepted ADR immutable except its
status line; naming the rules that enforce an unchanged decision does not
revise the decision, its alternatives, or what was believed when it was taken.)*

## Verification

Conformance 4.1–4.12 in memory mode and again against real adapters. The
architecture rules in `ENFORCEMENT.md` S and M run in `make ci`. **The extraction
claim in Part II §9 is explicitly not verified here.**

*(Rule D4: an ADR names how its claim is verified, or says it is not.)*
