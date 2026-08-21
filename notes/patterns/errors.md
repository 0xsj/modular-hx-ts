---
module: errors
layer: L0
---

# Kind-Tagged Errors

## What

One error type carrying a tag from a closed vocabulary. `AppError` holds a
`Kind` — `invalid`, `not_found`, `conflict`, `unavailable`, and six more — plus
a message, an optional `cause`, per-field problems, and structured details.
Every layer wraps with context on the way out; only the outermost edge turns a
`Kind` into a protocol code.

The vocabulary is deliberately small and closed. Adding a member is a real
decision, because every edge that maps kinds onto a protocol gains a case, and
forgetting one is how a new failure quietly becomes a 500.

## Why

Three problems, one type.

**Classification has to happen where the knowledge is.** Only the repository
knows that zero rows means "not found"; only the aggregate knows that a version
mismatch is a conflict rather than a bug. If classification is deferred to the
edge, the edge guesses from a string, and it guesses wrong the first time
somebody rewords a message.

**Context has to accumulate without losing the classification.** `wrap`
preserves the kind, the fields and the details, and chains the `cause`. A
`NotFound` from the repository is still a `NotFound` to the use case above it —
the message grows, the meaning does not change. Messages read outside-in once
chained, which is the order that helps: `load user: query user by id:
connection refused`.

**Retry needs one answer, not several.** `isRetryable` is decided here, once, so
`retry` and `breaker` read the same rule instead of each inventing one.

**Rejected: an error hierarchy** — `NotFoundError extends AppError` and so on.
It moves the tag into the type name, which reads well and then forces
`instanceof` ladders at every boundary, defeats serialization across a process
boundary, and makes "the same failure, one layer up" a new class rather than a
wrap. The tag is data; a subclass is not.

**Rejected: HTTP status codes on the error.** Tempting, and it is invariant I7's
first casualty. The moment `errors` knows what `404` means, the L0 kernel knows
about HTTP, and the same error can no longer be returned over a CLI, a queue, or
a gRPC boundary without lying. The mapping belongs in transport, and only there.

## Example

```ts
// domain/ — the only module a context's domain may import (rule S7).
export function rename(user: User, name: string): Result<User, AppError> {
  if (name.trim() === '') {
    return err(invalid('name is required', [
      { field: 'name', message: 'must not be blank' },
    ]));
  }
  return ok({ ...user, name });
}

// infra/ — classification happens where the knowledge is.
const row = await tx.query(sql, [id]);
if (row === undefined) return err(notFound(`no user with id ${id}`));

// app/ — context accumulates, the kind survives.
const user = await repository.load(id);
if (isErr(user)) return err(wrap(user.error, 'load user'));

// transport/ — and ONLY here does a Kind become a status.
const status = STATUS_BY_KIND[kindOf(error)] ?? 500;
```

## Gotchas

- **`cause: undefined` is not the same as no cause.** With
  `exactOptionalPropertyTypes`, an explicitly-undefined `cause` still creates
  the property, and `Error` prints an empty chain that reads like a root cause
  somebody lost. The constructor passes `cause` only when the caller gave one.
- **A conflict is not retryable.** It looks transient and is not: retrying a
  version mismatch without re-reading state reproduces the same mismatch. Only
  `unavailable` and `timeout` are retryable.
- **`wrap` does not re-classify.** If a failure needs a different kind one layer
  up, that is a new error with the old one as its cause, not a wrap. Silently
  re-tagging is how a `Forbidden` becomes a `500`.
- **Anything unclassified is `Internal`.** That is honest rather than
  convenient: a value that escaped without a kind escaped without anyone
  deciding what it means. It is also the only kind that should page anyone.
- **Cause chains can cycle.** Nothing should build one; something eventually
  will. `chain` tracks what it has seen, because a logger that hangs is worse
  than the bug it was printing.
- **`details` is not redacted.** This module cannot redact — [[redact]] is a
  sibling at the same layer, not a dependency — so nothing here stops a secret
  reaching a log. Put a `Secret` in `details` rather than a bare credential:
  whatever prints the error will then print `[redacted]` without having to know
  it should.

## Used in

- `src/shared/errors/index.ts`
- `src/shared/errors/index.test.ts`

This list grows to include every `domain/` in the repository: rule S7 makes this
the only module a context's domain may import, so every domain invariant that
can fail names its failure here.

## Related

[[result]] — expected failures returned as values; this is what those values
carry. [[retry]] and [[breaker]] both read `isRetryable`. [[redact]] is what
`details` should have passed through and cannot. [[httpx]] owns the
`Kind` → status table, per invariant I7.

Mandated by ADR 0001 (`docs/decisions/0001-architecture.md`); the import rule
that makes this module special is `S7`, in `../ENFORCEMENT.md`.
