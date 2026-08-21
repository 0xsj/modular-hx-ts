---
module: brand
layer: L0
---

# Brand

## What

Nominal types on a structural type system. `Brand<string, 'UserId'>` is a string
that only a `UserId` constructor produces, so passing an `OrgId` where a
`UserId` is meant stops compiling — even though both are UUID strings and
nothing at runtime can tell them apart.

The tag is a `declare`d `unique symbol` property, which means it exists only in
the type system. A branded value **is** its base value: it serializes,
concatenates and compares as one, and adds nothing at runtime.

`defineBrand(name, predicate)` returns `make` (validate and construct), `is`
(narrow), and `expect` (construct or throw).

## Why

Go gets this for free — `type UserId string` is a distinct type, and the
compiler refuses the mix. TypeScript is structural, so `UserId`, `OrgId` and
`SessionId` are all `string` and interchangeable. Every function taking three
ids in a row is one transposition away from a bug that typechecks, passes
review, and returns another tenant's data.

**The predicate is the definition of the type.** `UserId` is not "a string
somebody labelled UserId"; it is "a string that passed `isUuid`". That is the
return on the ceremony: a function taking a `UserId` needs no defensive check,
because there is no way to have obtained one without validation. Without the
predicate a brand is just a comment the compiler happens to enforce.

**Rejected: a string tag property.** `{ __brand: 'UserId' }` is the version most
blog posts show. It collides across libraries, appears in `Object.keys`, and
survives `JSON.stringify` — so the tag leaks into API responses and stored rows.
A `unique symbol` cannot collide and cannot be produced by accident.

**Rejected: wrapper classes.** `class UserId { constructor(readonly value: string) }`
is genuinely nominal and costs an allocation per id, a `.value` at every use, a
`toJSON`, and an equality function — `a === b` stops working. For a value that
is semantically a string, that is a lot of machinery to re-implement `string`.

**Rejected: an enum-based registry.** `erasableSyntaxOnly` forbids `enum`
outright, which settles it, and the reason that flag is on is the same reason
this design is: whatever tsc, esbuild and `node --experimental-strip-types` do
must be identical.

## Example

```ts
// Type and constructor under one name — TypeScript keeps them in separate
// namespaces, so `UserId` reads as one thing at every use site.
export type UserId = Brand<string, 'UserId'>;
export const UserId = defineBrand<string, 'UserId'>('UserId', isUuid);

// At the boundary: a raw string arrives, and either becomes a UserId or fails.
const id = UserId.make(request.params.id);
if (isErr(id)) return err(wrap(id.error, 'read user'));

// Inside: no defensive check, because there is no way to have got here without
// one. The signature is the guarantee.
async function load(id: UserId): Promise<Result<User>> { ... }

load(orgId);        // ✗ does not compile — and both are UUID strings
load('01a024c7…');  // ✗ does not compile — a plain string is not a UserId
```

## Gotchas

- **A brand does not survive JSON.** `JSON.parse(JSON.stringify(id))` is a plain
  `string`, because the tag never existed at runtime. Anything crossing a
  process boundary — a row, a job payload, a request body — must be re-branded
  through `make` on the way back in. That is not a flaw in the erasure; it is
  the only honest place to re-validate.
- **`unsafeBrand` skips the predicate.** Legitimate for rehydrating rows a store
  validated on the way in, where re-checking every row is cost without
  information. It is named to be greppable so a reviewer can count the uses; if
  the count is growing, the boundary is in the wrong place.
- **The constructor never echoes the value it rejected.** Brands wrap
  identifiers, and they also wrap API keys and tokens. A message quoting its
  input puts secrets in logs, and this module cannot redact — [[redact]] is a
  sibling at the same layer, not a dependency. So it is `not a valid ApiKey`,
  never the key.
- **`expect` throws; `make` returns.** `expect` is for literals whose validity
  is known while writing them — seed data, fixtures, config defaults. In a use
  case, a value came from outside and its failure is expected, so it is `make`.
- **Type-level assertions are checked by `make typecheck`, not by the test
  run.** `expectTypeOf` erases to nothing; its assertions fail as tsc errors.
  This is the only way to test a module whose entire behaviour is invisible at
  runtime, and it means a green `vitest` run alone proves nothing here.

### The kernel has an internal order

Three modules in, this is a fact rather than a coincidence: `errors` → `result`
→ `brand`, each importing the one before it. `S1` permits it — the rule is
*strictly lower layers*, and same-layer is allowed — but `../ARCHITECTURE.md` §2
asks that sideways edges be flagged in review rather than accumulated silently.

The order is not arbitrary. `errors` classifies, `result` carries a
classification, and `brand` produces one when a predicate fails. Each edge
points at something more fundamental than itself, so the sequence is acyclic and
`no-circular` keeps it that way. Expect the rest of L0 to depend on these three
and on little else.

## Used in

- `src/shared/brand/index.ts`
- `src/shared/brand/index.test.ts`

This list grows to include every `domain/` that names an identifier or a value
object: `UserId`, `OrgId`, `Email`, `SessionToken`.

## Related

[[errors]] — a failed `make` returns an `invalid` error. [[result]] — what
`make` returns. [[assert]] is its sibling in `../MODULES.md`, covering
invariants where this covers identity. [[id]] will generate the UUIDv7 values
most brands here wrap. [[redact]] is what a brand holding a secret should
wrap: a brand is erased, so it prints exactly like the string underneath it.
