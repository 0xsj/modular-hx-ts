# ADR 0004 — Enforcement is split across three tools, by rule class

**Status:** Accepted · **Date:** 2026-08-22

## Context

`../ENFORCEMENT.md` defines four families of rule and does not say what runs
them: `S` (import graph), `M` and `I` (claims about what code *does*), and
`N`/`D`/`R` (claims about documents). ADR 0001 lists which ids this repository
enforces; it does not say where they live, and until now nothing did.

The families are not the same kind of claim. *"`identity` must not import
`orgs`"* is a question about edges in a graph. *"a duration is measured on the
monotonic reading"* is a question about which method a call site invoked.
*"every module has a note naming its layer"* is a question about files on disk.
A tool that answers one well answers the others badly or not at all.

Getting this wrong is expensive in a specific way: the tool determines what a
new rule *can* say, so a bad home for a rule class quietly caps what the
collection is able to enforce later.

## Decision

Each rule class lives in the tool that can express it, and nowhere else.

| Class | Tool | Why that one |
| --- | --- | --- |
| `S1`–`S10` | `.dependency-cruiser.cjs` | The rules are about edges between modules; a graph tool states them declaratively and reports the path that violated one |
| `M2` · `M13` · `I5` | `tests/rules/semantic-rules.ts` (ts-morph) | Claims about call sites, which need the syntax tree and no import graph at all |
| `N` · `D` · `R` | `tests/rules/docs-rules.ts` | Claims about markdown and the filesystem, which neither of the above can see |

**ESLint holds no architecture rule.** It runs, and it enforces code style and
correctness lints only. This is the part most likely to be undone by someone
being helpful, so it is stated rather than left as an absence.

Two supporting commitments make the split hold:

- **`layers.cjs` is the single source of truth** for module→layer and for the
  vendor SDK table, read by both `.dependency-cruiser.cjs` and the docs test.
  Two copies of the layer map would drift, and `S1` and `N7` would then disagree
  about what layer a module is in while both stayed green.
- **Every rule is fixture-proved.** Each has a tree built to trip it and a clean
  control. On an empty repository every rule passes vacuously, so a rule with no
  fixture is an assertion that nothing has been checked. This is enforced by a
  test that names any rule without one.

## Alternatives considered

- **Everything in ESLint, as custom rules.** Genuinely viable, and the most
  common choice. Rejected: ESLint sees one file at a time, so an import-graph
  rule becomes a hand-rolled cross-file cache, and the failure message loses the
  path — *"`identity/user.ts` imports `orgs`"* instead of the chain that got
  there. It also puts architecture rules behind an `eslint-disable` comment,
  which is exactly the wrong affordance for a rule that must not be waived
  locally.
- **Everything in ts-morph, as one test suite.** Viable, and it would remove a
  dependency. Rejected: the `S` rules would become an import-graph
  implementation written here — a second, worse `dependency-cruiser` — and
  `S1`'s value is that the layer map is declarative and readable by someone who
  is not reading TypeScript.
- **Everything in `dependency-cruiser`.** Rejected: it has no view of a markdown
  file and no view of a call site.
- **Enforce nothing; rely on review.** Rejected by the collection, not here:
  `../ENFORCEMENT.md` exists because v1 lost parity to a discipline that eroded.

## Consequences

- Three places to look when a rule fails, and three places to add one. The
  mapping above is the answer to "where does this rule go", and it is short
  enough to hold in one's head.
- A rule that spans classes has no home. None exists today. If one appears, it
  is likely two rules.
- The docs rules are hand-written file parsing rather than a library, so they
  are ours to maintain. Accepted: the alternative is a markdown-lint
  configuration expressing claims it was not built for.
- Adding a rule means adding a fixture, which is roughly half the work. That is
  the intended tax.

## Verification

`tests/rules/arch.test.ts` and `tests/rules/docs.test.ts` run every rule against
its fixtures and assert each fires on the tree built to trip it and stays quiet
on the control. A separate test asserts that **no rule ships unproven** — it
enumerates the enforced ids and fails on any without a fixture. That test paid
for itself on the first run by naming five.

`tests/rules/docs.test.ts` additionally runs the whole rule set against this
repository, so the documents are held to the same rules they describe.

## Enforced by

The loop closes in both directions, which is `D5`:

`S1` · `S2` · `S3` · `S5` · `S6` · `S7` · `S8` · `S9` · `S10` — the import-graph
rules, each citing its ADR structurally through `mandatedBy`, so a rule cannot
be added without a citation.

`M2` · `M13` · `I5` — the semantic rules.

`N1` · `N2` · `N3` · `N4` · `N5` · `N6` · `N7` · `D1` · `D2` · `D4` · `D5` ·
`D7` · `R3` · `R4` · `R6` · `R7` — the document rules, including `D5` itself,
which is what makes this section load-bearing rather than decorative.
