---
topic: tsconfig strictness
---

# Strictness, and the code it forced

## What

Four `tsconfig.json` flags beyond `strict` shape more of this codebase than any
style guide does. Each one is here because it removes a class of bug, and each
one has a visible fingerprint in the source that looks odd until you know which
flag put it there.

| Flag | Fingerprint in the code |
| --- | --- |
| `erasableSyntaxOnly` | `const X = {...} as const` instead of `enum` |
| `verbatimModuleSyntax` | `import type { … }` everywhere |
| `noUncheckedIndexedAccess` | `const [row] = rows` and `?.` on every index |
| `exactOptionalPropertyTypes` | `...(x === undefined ? {} : { x })` spreads |

## Why

### `erasableSyntaxOnly` — the file must be valid JavaScript with the types deleted

No `enum`, no parameter properties (`constructor(private x)`), no `namespace`,
**and no decorators**. Every one of them emits runtime code, so a type-stripping
loader cannot handle them.

This is what makes `tsx` and Node's own type stripping work without a build
step, which is what `make dev` depends on. It also pushed `Kind` and `ActorKind`
into the const-object shape, which turned out better than `enum` regardless —
see [[type-system]].

**The decorator ban decided a design, and improved it.** `classification` needed
a way to attach a sensitivity level to a field, and a decorator is what most
TypeScript codebases would reach for. Forbidden here, so the declaration became
`Record<keyof T, Level>` — which is **strictly better for this purpose**,
because a decorator is opt-in *per field* while an exhaustive record is opt-out
per field. A field somebody forgot to decorate is silently unclassified; a field
missing from the record does not compile.

Worth recording as a constraint that improved the design, rather than being
remembered as something worked around.

### `verbatimModuleSyntax` — an import either exists at runtime or it does not

`import { type Clock, systemClock }` keeps the module; `import type { Clock }`
is erased whole. Without the flag, TypeScript guesses, and the guess changes
whether a module is loaded — which matters when the import has a side effect or
when a bundler is deciding what to keep.

The cost is one keyword. The return is that **the import list tells you what
runs**, which is exactly what `dependency-cruiser` reads for rules `S1`–`S10`.
A type-only import that looked like a real one would make a layering violation
out of nothing.

### `noUncheckedIndexedAccess` — an index can miss

`rows[0]` is `T | undefined`, not `T`. Every array index, every
`Record<string, T>` lookup.

This is the flag that produces the most friction and has caught the most real
bugs. The shape it forces:

```ts
const [row] = await db.query(sql);   // row: T | undefined
return row;                          // honest
```

`queryRow` returning `T | undefined` rather than throwing is a direct
consequence, and it is the right answer for a substrate: whether an absent row
is a 404, an empty option, or a reason to insert is the caller's decision.

### `exactOptionalPropertyTypes` — absent is not the same as `undefined`

`{ tenant?: string }` will not accept `{ tenant: undefined }`. So an optional
field is added conditionally:

```ts
...(actor.onBehalfOf === undefined ? {} : { on_behalf_of: … })
```

That spread appears in `provenance`, `logger`, `telemetry`, `postgres` and
`events`, and it looks like ceremony until you notice it is **the same rule the
collection requires on the wire**: absent fields are omitted, never `null` or
empty, because that is what keeps Go, Python and TypeScript producing identical
bytes.

The flag and the parity rule want the same thing, so the compiler enforces the
wire format for free. That convergence is worth knowing: it is why nobody here
has had to remember the rule.

## Gotchas

- **`TS4111` — a property from an index signature needs bracket access.**
  `process.env['DATABASE_URL']`, not `process.env.DATABASE_URL`;
  `attributes['request_id']`, not `.request_id`. It reads badly and it is
  correct: the property is not declared, so dot access would be a claim the type
  cannot support.
- **`noUnusedLocals` deletes your compile-time assertion** unless it is
  exported. See [[type-system]].
- **The `...( ? {} : {})` spread is not optional style.** Writing
  `{ tenant: maybeUndefined }` fails to compile, and `as` around it would defeat
  the flag and produce a `"tenant": null` on the wire that a sibling repository
  would not produce.
- **Two TypeScripts are installed**, and only one of them typechecks. See
  [[tooling]] — a construct valid in 7 and unparseable in 6 would pass
  `make typecheck` and break `make lint`.
- **A `Record<keyof T, X>` is the erasable answer to a decorator**, and the
  better one. See above; it is how `classification` declares levels and how
  `M9` became a compile error rather than only a lint.

## Used in

- `tsconfig.json`
- `src/shared/postgres/db.ts`
- `src/shared/provenance/actor.ts`
- `src/shared/classification/registry.ts`

Every module, in practice — these flags are why several idioms here look the way
they do.

## Related

[[type-system]] — the devices these flags push you toward. [[tooling]] — the
compiler that enforces them, and the second one that does not. [[provenance]] —
where omit-absent is a parity requirement as well as a compiler one. [[digest]]
— the same rule, at the bytes.
