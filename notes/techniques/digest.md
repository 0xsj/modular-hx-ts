---
module: digest
layer: L0
---

# Digest

## What

Canonical JSON per RFC 8785, and `sha256:` content identities over it.
`canonicalize` produces the canonical text, `canonicalBytes` its UTF-8 bytes,
and `digest` the identity. `Digest` is a branded `sha256:` string.

Two values with the same digest are the same value — for any implementation
that follows the same RFC, not just this one.

## Why

### Determinism is the whole product

A content identity is only useful if it is reproducible. The moment two
serializers disagree — about key order, about how `1e30` is written, about
whether a missing field is absent or null — the identity stops identifying
anything and starts identifying *the serializer*.

`JSON.stringify` is not that. It preserves insertion order, so two objects with
the same fields hash differently depending on how they were built. That single
fact is why this module exists.

### RFC 8785 is short in JavaScript, and that is not an accident

The RFC was written around ECMAScript's own number and string rules, so the two
hardest parts are already solved by the platform:

- **Numbers.** §3.2.2.3 defers to ECMAScript `Number::toString`, which is
  exactly `String(n)` — including `"0"` for `-0` and `"1e+21"` for `1e21`.
- **Strings.** §3.2.2.2 is JSON's own escaping with the minimal choices, which
  is exactly `JSON.stringify(s)`.
- **Keys.** §3.2.3 sorts by UTF-16 code unit, which is what the default string
  sort already does.

What is left is recursion, key sorting, and refusing everything JSON cannot
carry.

### Refusing is the design

Every refusal here replaces a silent divergence with a loud one at the boundary:

- **`undefined`** — `JSON.stringify` drops the key. A language without
  `undefined` would write `null` or omit it by a different rule, so the same
  model produces different bytes. The error says *omit the key or use null*,
  which makes the caller choose.
- **`NaN` and `Infinity`** — `JSON.stringify` writes `null`, quietly turning a
  broken computation into a valid document.
- **`Date`, `Map`, class instances** — each has a plausible encoding and no
  agreed one. Guessing is how two implementations of the same model drift apart
  without anyone noticing.
- **Cycles** — refused with the path, rather than overflowing the stack.

**Rejected: sorting arrays.** Array order is data. `[1,2]` and `[2,1]` are
different values and must have different digests.

**Rejected: hashing `JSON.stringify` output.** It is fast, it is one line, and
it makes the digest depend on object construction order — which is to say, on
nothing meaningful.

## Example

```ts
// A stable identity for a value, independent of how it was built.
const id = unwrap(digest({ email: 'ada@example.com', roles: ['admin'] }));
// sha256:…

// Idempotency: the same request body is the same key.
const key = unwrap(digest(request.body));

// Comparing two payloads without comparing field by field.
if (unwrap(digest(before)) === unwrap(digest(after))) return noChange();
```

## Gotchas

- **Integers above 2^53 lose precision before they get here.** JSON numbers are
  doubles. An id or a monetary amount that must survive exactly should be a
  string, and monetary amounts should be minor units anyway.
- **`Object.keys` hoists integer-like keys.** `{ '1': …, 'a': … }` enumerates
  `'1'` first regardless of insertion order, so parsing canonical text back into
  an object and reading its keys does **not** show canonical order. Read the
  order off the text. This bit the test for this module before it bit anything
  else.
- **A shared reference is not a cycle.** The same object appearing twice is
  serialized twice; only a reference back into its own ancestry is refused.
- **The digest covers the canonical bytes, not the value's meaning.** `{"a":1}`
  and `{"a":1.0}` are the same digest because they are the same number.
  `{"a":1}` and `{"a":"1"}` are not, because they are not.
- **A refusal names its path** — `users.1.name` — because a canonicalization
  failure deep in a payload is otherwise unfindable.

## Used in

- `src/shared/digest/index.ts`
- `src/shared/digest/index.test.ts`

This list grows to idempotency keys, event payload identities, and anywhere two
structures have to be compared for equality without walking them.

## Related

[[brand]] — what makes `Digest` a distinct type from `string`. [[result]] and
[[errors]] — how a value that cannot be canonicalized is refused. [[random]] —
the other side of the same coin: this is deterministic hashing, that is
unpredictable generation, and they are easy to confuse.
