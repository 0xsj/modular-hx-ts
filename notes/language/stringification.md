---
topic: how javascript turns values into text
---

# Stringification, and why it is load-bearing twice

## What

JavaScript has **four independent paths** from a value to text, and this
repository depends on that fact in two opposite directions:

- `redact` must close **all four**, or a secret leaks through the one that was
  missed.
- `digest` must reproduce **exactly** what RFC 8785 specifies, which it does
  almost for free — because the RFC was written around ECMAScript's own rules.

| Path | Trigger | Honours |
| --- | --- | --- |
| `Symbol.toPrimitive` | `` `${x}` ``, `x + ''`, `String(x)` | itself first |
| `toString` | the above, when no `Symbol.toPrimitive` | itself |
| `toJSON` | `JSON.stringify(x)` | itself |
| `nodejs.util.inspect.custom` | `console.log(x)`, `util.inspect(x)` | itself only |

## Why

### `util.inspect` is the one everyone misses

`console.log` does **not** call `toString`. It calls `util.inspect`, which walks
own properties and ignores `toString` entirely. A `Secret` that defines only
`toString` prints its contents the first time somebody debugs with
`console.log`, and looks perfectly safe in every test that used a template
literal.

That is why `Secret` implements all four, with the value in a `#private` field
so the property walk finds nothing to print. The test file has one case per
path, deliberately.

### `toJSON` on a class is the only route to correct JSON

Private fields are invisible to `JSON.stringify`, so a class with `#fields`
serializes to `{}` unless it defines `toJSON`. Rather than a defect, that is the
lever: `Provenance`, `Actor` and `Envelope` all define `toJSON`, so an
**accidental** `JSON.stringify` produces the right bytes rather than an empty
object — and the omit-absent-never-null rule is applied in one place.

### RFC 8785 is short in JavaScript, and that is not a coincidence

The JSON Canonicalization Scheme defers to ECMAScript for the two hardest parts:

| RFC 8785 | JavaScript |
| --- | --- |
| §3.2.2.3 number serialization | `String(n)` — including `"0"` for `-0` and `"1e+21"` for `1e21` |
| §3.2.2.2 string escaping | `JSON.stringify(s)` — the minimal-escape form |
| §3.2.3 key ordering | `.sort()` — the default comparator is UTF-16 code unit order |

So the whole of `canonicalize` is key ordering, refusing what JSON cannot carry,
and recursion. **Nothing here re-implements a serializer**, which is why this
repo agrees byte-for-byte with the Go and Python implementations on all fifteen
cross-language vectors.

The one to be careful with is `.sort()`. It is correct **only** because the
default comparator compares UTF-16 code units, which is exactly what the RFC
asks for. `localeCompare` looks like an improvement and is wrong — swapping it
in turns the `utf16-key-sort` and `mixed` vectors red, which is how that was
confirmed rather than assumed.

## Gotchas

- **`String(x)` uses `Symbol.toPrimitive` before `toString`.** Implementing only
  the latter leaves a hole that `${x}` may or may not hit depending on context.
- **`JSON.stringify` drops `undefined` properties silently.** Go has no
  `undefined`, so a model that relies on that drop diverges between languages.
  `digest` refuses `undefined` with a message telling the caller to omit the key
  or use `null`.
- **`JSON.stringify` writes `null` for `NaN` and `Infinity`**, turning a broken
  computation into a valid document. `digest` refuses both.
- **`Object.keys` hoists integer-like keys.** `{ '1': …, 'a': … }` enumerates
  `'1'` first regardless of insertion order — so parsing canonical text back and
  reading its keys does **not** show canonical order. Read the order off the
  text. This produced a test that passed for the wrong reason before it produced
  a bug.
- **Rebuilding an object from its enumerable properties destroys most things.**
  `Error.message` and `.stack` are not enumerable, a `Date` has no own
  properties at all, and everything loses its prototype. Both were live bugs in
  `redactKeys`, found by running the logger rather than by any unit test.
- **A raw control byte in a source file makes it binary.** Not stringification,
  but the same family: TypeScript parses a literal `NUL` happily, and `file(1)`
  then reports `data` while `grep` skips the file entirely. Write the escape.
  **This happened twice** — once in the digest test, and again a week later in
  `mailer`'s control-character regex, the module whose entire subject is control
  characters. `tests/rules/encoding.test.ts` now fails the build on either.
- **Writing a control character *into a test* needs `String.fromCharCode`.**
  `mailer`'s injection cases build `CR` and `LF` that way rather than embedding
  them, so the test asserting that a newline is rejected does not itself contain
  the newline that would make the file unreadable to every text tool.

## Used in

- `src/shared/redact/index.ts`
- `src/shared/digest/index.ts`
- `src/shared/provenance/provenance.ts`

## Related

[[redact]] — closing all four paths, and why. [[digest]] — the canonical form
and the cross-language vectors. [[type-system]] — `#private`, which is what
makes the property walk find nothing. [[errors]] — the leak that started it: an
`AppError` reaching a log line with its message gone.
