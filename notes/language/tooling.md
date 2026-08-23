---
topic: typescript toolchain
---

# The toolchain, and the two compilers

## What

pnpm 11, Node 24 (pinned exactly), TypeScript **7 and 6 side by side**, Vitest 4,
ESLint, Prettier, dependency-cruiser and ts-morph. `make` is the interface;
every script exists because a Make target calls it.

## Why

### Two TypeScripts, because two tools read the AST rather than invoke the compiler

`typescript7` builds and typechecks. `typescript` 6.0.3 is what
`typescript-eslint` and `dependency-cruiser` parse with — neither supports
TypeScript 7, and `typescript-eslint` caps its peer range at `<6.1.0`.

Giving up either half was worse: rules `S1`–`S10` are evaluated by
dependency-cruiser, so a toolchain choice that switched them off would be an
architecture decision in disguise. ADR 0003.

The consequence to remember: **`tsc` on `PATH` is ambiguous**, so every script
names the compiler by path — `node node_modules/typescript7/bin/tsc`. A script
that relied on resolution order would go green against the wrong compiler, which
is the exact failure this arrangement exists to avoid.

### pnpm's layout is not `node_modules/<pkg>`

An installed package resolves to
`node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/…`.

That is not trivia. The `S10` vendor-confinement rules matched
`^(node_modules/)?<pkg>` and therefore matched only the **unresolvable** form —
the shape dependency-cruiser reports for a package that is declared in a rule and
not installed. Every `S10` entry passed vacuously for any package actually
installed, and nothing was installed until `pg`. The fixture went red on the same
commit that added it.

A fixture tree has no `node_modules`, so a fixture **cannot** cover the resolved
form. `tests/rules/arch.test.ts` asserts all three layouts against the pattern
directly.

### Vitest: three projects, and a global setup for the gate

`unit` needs nothing and is rung 0. `integration` and `e2e` need the compose
stack. Selecting a project is how `make test` stays hermetic.

`globalSetup` + `provide`/`inject` is the mechanism for anything that must be
decided **once per run** rather than once per worker — the database reachability
probe, for instance. `describe.skipIf` then skips with the reason in the title.

## Gotchas

- **`eslint --fix` rewrites code between your reading it and your editing it.**
  It converted a call-signature `interface` into a `type` alias, after which a
  string replacement matched nothing and reported success. Assert on every
  replacement; the failure was only caught because typecheck ran afterwards.
- **Prettier and the rule tests disagree about nothing, but run in that order.**
  `make ci` is `fmt-check` first, so an unformatted file fails before anything
  more interesting does. Format as you go.
- **`engine-strict` makes the wrong Node fail at install**, not three rungs up.
  The engine warning currently printed is a real drift — `.nvmrc` says 24 and
  this machine runs 22 — and it is a warning rather than an error only because
  the scripts are invoked directly.
- **A skipped vitest suite prints as a bare count** under the default reporter.
  The reason has to go in the suite title *and* on stderr, or `4 skipped` reads
  as a pass.
- **`it.each(objects)('$name', …)`** interpolates a property into the test name,
  which is what makes fifteen fixture vectors report individually rather than as
  one opaque case.
- **A lint rule sometimes forbids the thing under test.** `no-control-regex`
  objects to the pattern that *is* `mailer`'s header-injection check, and
  `only-throw-error` objects to the non-Error throw that `events` has to
  tolerate. Both are disabled on one line with the reason, because a rule that
  quietly prevents a security test from being written is worse than an
  exception somebody can read.
- **`require-await` will push you into a real bug.** Removing `async` from a
  function with nothing to await changes a `throw` from a rejection into a
  synchronous throw. Return `Promise.reject` instead — see [[runtime]].
- **The test harness grows a file per service, not a redesign.** `testx` gained
  `mailpit.ts` beside `postgres.ts` when `mailer` landed, plus a reachability
  probe so the suite skips rather than fails. That shape was chosen before there
  was a second service, which is the only time it is cheap to choose.

## Used in

- `package.json`
- `Makefile`
- `vitest.config.ts`
- `.dependency-cruiser.cjs`
- `tests/rules/arch.test.ts`

## Related

[[strictness]] — the flags the build enforces. [[type-system]] — what the
compiler is being asked to prove. [[postgres]] — the first vendor package, and
what it revealed about `S10`.
