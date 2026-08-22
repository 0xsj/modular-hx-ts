# ADR 0003 — Two TypeScript compilers, side by side

**Status:** Accepted · **Date:** 2026-08-22

## Context

This repository builds and typechecks with **TypeScript 7** (`7.0.2`, the native
compiler). Two tools in the verification ladder read the syntax tree rather than
invoke the compiler — `typescript-eslint` and `dependency-cruiser` — and neither
supports TypeScript 7. `typescript-eslint` caps its peer range at `<6.1.0`,
canary releases included.

So a single compiler version cannot satisfy both halves of `make ci`. One of
them has to be given a different TypeScript, or one of them has to be given up.

This is not a preference about compiler speed. Rules `S1`–`S10` are enforced by
`dependency-cruiser`, and `make lint` is where a layering violation is caught;
a toolchain choice that switched those rules off would be an architecture
decision wearing a build-tooling costume.

## Decision

Both, installed side by side, which is the layout TypeScript 7 ships for:

```jsonc
"typescript":  "6.0.3",              // what typescript-eslint and depcruise parse with
"typescript7": "npm:typescript@7.0.2" // what builds and typechecks
```

`tsc` on `PATH` is therefore ambiguous, so **every script names the compiler by
path** — `node node_modules/typescript7/bin/tsc` — rather than relying on
resolution order. An ambiguous `tsc` that silently picked the wrong one would
produce a green build against the wrong compiler, which is the failure mode this
arrangement exists to avoid and would otherwise quietly create.

The two versions are not required to agree, and are not assumed to. TypeScript 7
is authoritative for whether the code compiles; TypeScript 6 is used only to
parse for lint and import-graph analysis, where the type checker's answers are
not consulted.

## Alternatives considered

- **Stay entirely on TypeScript 6 until `typescript-eslint` catches up.**
  Viable, and the conservative choice. Rejected because the wait is open-ended,
  and because a blueprint that exists to be copied should demonstrate the
  current toolchain rather than the one being replaced — `../MODULES.md` treats
  the language as this repository's single variable, and pinning it a major
  version back makes that variable less honest.
- **Drop `dependency-cruiser` and express `S1`–`S10` as ESLint rules.** Rejected:
  it trades an architecture rule set for a build convenience. See ADR 0004 for
  why the rules live where they do.
- **Drop linting on the architecture rules and rely on review.** Rejected — the
  collection's whole enforcement premise (`../ENFORCEMENT.md`) is that a rule
  nobody tests is a rule nobody follows.
- **`skipLibCheck` or a shim so one compiler serves both.** Rejected: the
  incompatibility is in the AST API, not in type resolution, so there is nothing
  to skip.

## Consequences

- `package.json` carries two entries that look like a mistake, and a reader who
  does not know why will try to remove one. The manifest and `docs/TREE.md` both
  say why, at the point of contact.
- Upgrades are two moves, not one, and they can be made independently — which is
  the point: `typescript-eslint` gaining TypeScript 7 support retires the second
  entry with no change to any source file.
- A construct valid in 7 and unparseable in 6 would break `make lint` while
  `make typecheck` stayed green. Not encountered; `erasableSyntaxOnly` in
  `tsconfig.json` narrows the surface where it could happen.

## Verification

`make ci` runs both compilers on every push — `make lint` through the 6-based
tools, `make typecheck` and `make build` through 7. A divergence between them
fails the ladder rather than being discovered later. There is no test asserting
the two versions *agree*, and there should not be: they are used for different
questions.

## Enforced by

Nothing structural. This is a toolchain decision, not an architecture rule, so
no rule id in `../ENFORCEMENT.md` corresponds to it and none is invented — the
verification above is the whole of it.

It is what makes `S1`–`S10` enforceable at all, since `dependency-cruiser` is
the tool that evaluates them.
