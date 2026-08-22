---
topic: typescript type system
---

# The type system, doing architectural work

## What

Where this repo leans on TypeScript's type system to enforce things other
blueprints enforce with a rule, a test, or a code review — and where it
deliberately does not, because a type is erased and a runtime guard is not.

Five devices carry almost all of it: **branded types**, **closed enums without
`enum`**, **a type and a value under one name**, **compile-time assertions**, and
**`#private` fields**.

## Why

### Branded types, because structural typing has no opinion

TypeScript compares shapes, so `Millis` and `Uuid` are both just `number` and
`string` to the compiler — and `sleep(userId)` typechecks. A brand adds a
phantom property that nothing can produce accidentally:

```ts
type Brand<T, K> = T & { readonly __brand: K };
type Millis = Brand<number, 'Millis'>;
```

Erased entirely at runtime: a `Millis` **is** a number, arithmetic works, and
`JSON.stringify` sees a number. The cost is that construction goes through
`millis(n)`, which is the point — one place to validate.

Go gets this free with `type Millis time.Duration`. This is the TypeScript
spelling of the same idea, and it is worth naming because a reader coming from
Go will look for a declaration that does not exist.

### Closed enums, without `enum`

`erasableSyntaxOnly` forbids `enum` — it emits an object, so it is not erasable.
The replacement is better anyway:

```ts
export const Kind = { Invalid: 'invalid', NotFound: 'not_found' } as const;
export type Kind = (typeof Kind)[keyof typeof Kind];
```

One name for the value and the type, the values are the wire strings, and the
union is closed so a `switch` is exhaustively checked. A TypeScript `enum` gives
none of that cleanly: numeric enums are not the wire format and string enums are
still a runtime object nobody wanted.

Used for `Kind`, `ActorKind`, and the log `LEVELS`.

### A type and a value under one name

TypeScript keeps types and values in **separate namespaces**, so one identifier
can be both:

```ts
export type Actor = ActorValue;          // the type
export const Actor = { user, service };  // the constructors
```

`actor: Actor` and `Actor.user(id)` then read as the same thing. This is how
`Actor`, `Provenance` and `Kind` are all shaped, and it is why there is no
`ActorFactory` or `NewActor` anywhere.

### Compile-time assertions

A type that fails to compile is a test that costs nothing to run:

```ts
type Assert<T extends true> = T;
export type PoolSatisfiesTransactor = Assert<
  Postgres extends Transactor ? true : false
>;
```

`Transactor` is consumer-declared in `app/`, so nothing downstream can notice
the provider drifting. This line moves the break into `postgres` — the module
that drifted stops compiling. Verified by drifting `withinTx` on purpose:
`Type 'false' does not satisfy the constraint 'true'`.

The same device pins `Clock` to exactly two members, so a third cannot be added
quietly.

### Discriminated unions, not exceptions, for expected failure

```ts
type Result<T, E = AppError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

`if (!result.ok)` narrows both branches, so the compiler enforces that the error
case is handled before `.value` is reachable. Go's `(T, error)` needs discipline
to check; this needs none.

### `#private` is real; `private` is a suggestion

`private` is a **type-level** annotation, erased at runtime and reachable from
JavaScript, through `Object.keys`, and through a spread. `#field` is a genuine
runtime hard-private.

That difference is the whole reason `Secret`, `Provenance`, `Actor` and
`Envelope` use `#`. `Secret` in particular would be pointless with `private`:
`{ ...secret }` would leak the value to anything that spread it, and the module
exists to make that impossible.

The apparent cost — an accessor per field, no object literals — is not a real
cost, because custom serialization was required anyway: absent fields must be
omitted rather than `null` for cross-language parity, and `traceparent` must be
excluded from hashed bytes. Neither is achievable with default marshalling.

## Gotchas

- **A brand is erased, so it protects the boundary and not the value.** Anything
  arriving from JSON is `number`, not `Millis`, until a constructor says so.
  `unsafeBrand` exists for the constructor and is deliberately ugly.
- **`as const` is load-bearing on the enum objects.** Without it the values widen
  to `string` and the union stops being closed, silently.
- **`instanceof` does not work on a `type X = XValue` alias.** The class is not
  exported under that name, so the guard has to be `X.is(value)`. This bit while
  writing `Envelope.seal`.
- **A compile-time assertion must be *used* or exported**, or lint removes it as
  dead. Exporting the type is the cheapest way to keep it.
- **`#private` fields break `structuredClone` and spread-based copying.** That is
  the intent, but it means a testkit builder is sometimes the only ergonomic way
  to construct one for a test — hence `provenance.testkit.ts`.

## Used in

- `src/shared/brand/index.ts`
- `src/shared/errors/index.ts`
- `src/shared/result/index.ts`
- `src/shared/provenance/actor.ts`
- `src/shared/postgres/pool.ts`

## Related

[[brand]] — the module. [[result]] and [[errors]] — the discriminated union and
the closed `Kind`. [[redact]] — where `#private` is a security control rather
than a style. [[strictness]] — the compiler flags that force several of these
shapes. [[provenance]] — private fields plus explicit `toJSON`, for the parity
reason.
