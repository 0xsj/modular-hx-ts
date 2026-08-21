---
module: result
layer: L0
---

# Result

## What

`Result<T, E = AppError>` is a discriminated union — `{ ok: true, value }` or
`{ ok: false, error }` — with standalone helpers rather than methods. An
operation whose failure was anticipated returns one instead of throwing.

The rule it encodes: **a failure you expected is a value; a failure you did not
is a throw.** A repository returning "no such user" returns an `Err`, because
every caller has to handle it. A repository whose connection pool is corrupt
throws, because no caller planned for that and turning it into a value only
moves the crash somewhere less informative.

## Why

TypeScript has no equivalent of Go's second return value, and no compiler that
nags about ignoring it. `const user = await repo.load(id)` compiles whether or
not the author thought about failure. Making the failure part of the *type*
puts that back: you cannot reach `user.email` without first getting past `.ok`.

**Rejected: a class with combinators.** `result.map().andThen().unwrapOr()`
chains more fluently, and then three things go wrong. Methods do not survive
`JSON.stringify`, so a `Result` cannot sit in a job payload or cross a process
boundary. `instanceof` becomes load-bearing, which breaks across module
instances. And a class with `map` and `andThen` is a monad with the paperwork
filed later — the next commit adds `traverse`, and the one after that is a
library nobody asked for. A plain object narrows with `if (result.ok)`, needs no
import, and reads the same in a debugger as it does in source.

**Rejected: throwing everywhere.** Exceptions are invisible in a signature.
Every `await` becomes a possible non-local exit, and the honest handling of
"this user might not exist" ends up in a `catch` block three frames away that
also catches the bugs.

**Rejected: returning `null` or `undefined`.** It answers "was there a value"
and nothing else. `notFound` and `unavailable` are different failures with
different retry behaviour and different status codes, and `null` erases the
distinction at exactly the moment it matters.

## Example

```ts
// infra/ — classify where the knowledge is, return where it is expected.
async function load(id: UserId): Promise<Result<User>> {
  const rows = await attemptAsync(() => pool.query(SELECT_USER, [id]), 'query user');
  if (isErr(rows)) return rows;                       // already wrapped and classified

  const row = rows.value.at(0);
  return row === undefined ? err(notFound(`no user ${id}`)) : ok(toUser(row));
}

// app/ — steps compose, the first failure short-circuits the rest.
const user = await repository.load(id);
if (isErr(user)) return err(wrap(user.error, 'rename user'));

// transport/ — one exhaustive exit.
return match(result, {
  ok:  (user)  => reply.send(toResponse(user)),
  err: (error) => reply.status(STATUS_BY_KIND[error.kind] ?? 500).send(problem(error)),
});
```

## Gotchas

- **`unwrap` inside a use case is a smell.** It throws, which is the thing this
  type exists to avoid. It is for tests and for the composition root, where
  there is no caller left to return to. Reaching for it elsewhere means the
  failure was expected after all and should have been handled.
- **TypeScript narrows a `const` at its declaration.** `const r: Result<User> =
  ok(ada)` is *known* to be `Ok`, so the `else` branch is dead and a test
  written that way tests nothing. Put the value behind a function boundary. This
  one got caught by lint rather than by review, which is the argument for
  `no-unnecessary-condition` being on.
- **`all` returns the first failure, not every failure.** These are steps, and
  step three running after step two failed is the bug the type prevents.
  Collecting every problem is validation, and `AppError.fields` carries those.
- **`attempt` classifies as `Internal` unless the thrown value already had a
  kind.** That is correct — a throw nobody classified is a throw nobody thought
  about — but it means the message is the only clue. Give `attempt` a real one:
  `'query user by id'`, not `'error'`.
- **Rejections are not always `Error`s.** Drivers reject with strings and with
  plain objects. `attempt`, `attemptAsync` and `unwrap` all handle that; code
  that catches by hand usually does not.
- **This module imports `errors`, sideways within L0.** Deliberate, and allowed
  by rule `S1`, but it is the kind of edge `../ARCHITECTURE.md` §2 asks to be
  flagged in review. The alternative — a fully generic `Result` with a mapper
  argument at every call site — buys purity that no caller benefits from.

## Used in

- `src/shared/result/index.ts`
- `src/shared/result/index.test.ts`

This list grows to include every `app/` use case and every `infra/` repository
in the repository: returning a `Result` is what those layers do.

## Related

[[errors]] — what an `Err` carries, and where `wrap` and `Kind` come from.
[[retry]] and [[breaker]] read `isRetryable` off the error inside a failed
`Result`. [[validate]] does not exist here; zod covers the boundary, and its
problems arrive as `AppError.fields`.
