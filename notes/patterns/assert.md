---
module: assert
layer: L0
---

# Assert

## What

Five helpers for conditions the code believes impossible: `invariant`,
`assertDefined`, `must`, `assertNever` and `unreachable`. All of them throw an
`Internal` error. Three of them narrow types, so they replace a check *and* the
cast that usually follows it.

`../MODULES.md` pairs this with `brand` in one row — TypeScript needs both
because Go's type system supplies them. Brand covers identity; assert covers
invariants.

## Why

This is the other half of the rule [[result]] encodes. **A failure you expected
is a value; a failure you did not is a throw.** An assertion fires on something
that cannot happen unless the program is wrong, so there is nothing for a caller
to handle, and pretending otherwise — returning a `Result` nobody can act on —
just spreads the bug across more code.

The corollary is the one that matters in review: **if a condition here can be
reached by anything a user typed, it was never an invariant.** It is validation,
and it belongs in a `Result` with an `invalid` kind.

`assertNever` earns the module on its own. Because its parameter is `never`,
adding a member to a union turns every unhandled `switch` into a **compile**
error. That is exactly the failure the [[errors]] note warns about — a new
`Kind` quietly becoming a 500 — converted from a production surprise into a
build failure.

`must` exists because of the compiler settings. Under `noUncheckedIndexedAccess`
and `exactOptionalPropertyTypes`, "the type says it might be missing, the code
knows it is not" comes up constantly.

**Rejected: `node:assert`.** It throws `AssertionError`, which carries no
`Kind`, so it arrives at the edge unclassified and maps to a 500 by accident
rather than by decision. It also has a process-level personality — `assert` in
Node is entangled with `--throw-deprecation` and friends — where this is a plain
function that returns a typed error. And it does not narrow.

**Rejected: the non-null assertion `!`.** `rows.at(0)!.id` is shorter and says
nothing. When it fires you get `Cannot read properties of undefined`, a stack
trace, and no idea what was supposed to be there. `must(rows.at(0), 'first
row')` costs nine characters and explains itself at three in the morning.

**Rejected: stripping assertions in production.** C and Go build tags make
assertions vanish in release builds. These always run. An invariant that only
holds in development is not an invariant, and the cost of a truthiness check is
not the reason anything is slow.

## Example

```ts
// Exhaustiveness — the compile error is the feature.
function statusFor(kind: Kind): number {
  switch (kind) {
    case 'not_found':   return 404;
    case 'conflict':    return 409;
    // …every other kind…
    default:            return assertNever(kind, 'Kind');
  }
}

// Narrowing, without a cast and without a bang.
invariant(user !== undefined, 'the aggregate was loaded before rename');
user.rename(name);                        // `user` is narrowed here

// As an expression, where a statement will not fit.
const first = must(rows.at(0), 'first row of a COUNT query');
```

## Gotchas

- **An assertion function must be called through an explicitly-typed name.**
  Aliasing one — `const check = invariant` — fails with `TS2775`, *"Assertions
  require every name in the call target to be declared with an explicit type
  annotation"*, and the narrowing silently does not happen. Import them
  directly; never re-export them through a `const`, an object, or a destructure.
- **`assertDefined` is not a truthiness check.** `0`, `''` and `false` are
  present and pass. This is the bug the function exists to avoid, so it has
  three tests of its own and should not be "simplified" into `if (!value)`.
- **`invariant` *is* a truthiness check**, deliberately, and the opposite
  polarity to the above. Both are pinned by tests so the asymmetry survives
  someone tidying up.
- **These render values in messages; [[brand]] refuses to.** Not drift.
  `brand.make` takes arbitrary untrusted input — an API key, a token — so
  echoing it puts secrets in logs. `assertNever` receives a value the compiler
  already exhausted to `never`, which by construction is a discriminant. Even
  so, only primitives are rendered: anything structural is described as
  `[object]`, because an object could be a whole aggregate. Strings are capped
  at 64 characters.
- **Everything here throws `Internal`**, which is the only kind that should page
  anyone. Using `invariant` for something a request can trigger turns a 400 into
  an alert, and the on-call engineer into a validator.

## Used in

- `src/shared/assert/index.ts`
- `src/shared/assert/index.test.ts`

This list grows wherever a type is wider than the code's knowledge: aggregate
loads inside a use case, `switch` statements over a domain union, and the first
row of a query that cannot return zero rows.

## Related

[[errors]] — every assertion throws `internal(...)` from there. [[result]] —
the other half of the expected/unexpected split, and where a condition belongs
when a user can reach it. [[brand]] — its sibling in `../MODULES.md`, and the
counter-example on rendering values. [[redact]] is what makes a value safe to
render: wrap it in a `Secret` and every path to text prints `[redacted]`.
