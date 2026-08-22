---
module: redact
layer: L0
---

# Redact

## What

One place for "this must never print". `secret(value)` wraps a value so it
cannot be printed by accident; `expose()` is the only way out. `redactKeys`
scrubs a structure by key name for a log line. `mask` reveals the last few
characters for the support case.

`../MODULES.md` marks this **×5** — written five times in v1 and never
extracted. The rule that produced: *the third copy gets extracted; two may be
coincidence, three is a pattern.*

## Why

### Discipline does not survive debugging

A leaked credential is almost never a considered decision. It is a `console.log`
added at 2am and not removed, a template literal in an error message, an object
spread into a log line, a whole request body handed to a logger. Every one of
those is written by someone who knows perfectly well not to log secrets, and is
thinking about something else at the time.

A convention cannot help there. A type that **cannot print itself** can.

### Four escape hatches, and missing one is the whole bug

TypeScript has four independent paths from a value to text, and they do not
share a mechanism:

| Written as | Goes through |
| --- | --- |
| `` `${x}` ``, `String(x)` | `Symbol.toPrimitive`, then `toString` |
| `x.toString()` | `toString` |
| `JSON.stringify(x)` | `toJSON` |
| `console.log(x)` | `nodejs.util.inspect.custom` |
| `{...x}`, `Object.keys(x)` | own enumerable properties |

`util.inspect` is the one most implementations miss, and it is the one that
matters most: it **ignores `toString` entirely**, so a `Secret` that defines
only `toString` prints its contents to every `console.log` — the exact call the
type was introduced to make safe. The value lives in a `#private` field, which
closes the last row.

The stringification methods are declared on the **interface**, not only
implemented on the class, so the guarantee is visible in the type rather than
learned by reading the implementation.

### `expose()` is deliberately ugly

Not `.value`, not a getter. Every call is a point where a secret enters plain
memory, and one search should find all of them. A property would be invisible
in review and irresistible in autocomplete.

**Rejected: scrubbing at the logger.** A regex over formatted output is the
version everyone builds first. It runs after the value has already been turned
into a string, it cannot know which fields are sensitive, and it is one log
sink away from being bypassed entirely. `redactKeys` exists for the case where
you are handed a bag of fields you do not own; `Secret` is for values you do.

**Rejected: encryption at rest in the process.** A secret you can use is a
secret that is in memory in the clear at some point. This makes accidental
*printing* impossible, which is the realistic threat; it is not a defence
against a heap dump, and pretending otherwise would be worse than saying so.

## Example

```ts
interface SmtpConfig {
  readonly host: string;
  readonly password: Secret<string>;
}

logger.info('smtp configured', config);   // password prints as [redacted]
console.log(config);                      // so does this
JSON.stringify(config);                   // and this

await transport.connect({ pass: config.password.expose() });  // greppable

// For a bag of fields you were given rather than a value you own:
logger.warn('upstream rejected the request', redactKeys(request.headers));
```

## Gotchas

- **`expose()` is the boundary, and it is one-way.** Once exposed, the value is
  an ordinary string and every protection is gone. Expose as late as possible
  and never into a variable that outlives the call.
- **Key matching strips case *and* separators.** `X-Api-Key`, `api_key` and
  `apiKey` are one key. That gap is not hypothetical: the first version of this
  module missed the hyphenated header form, which is exactly where it matters,
  and the test caught it.
- **`redactKeys` over-matches on purpose.** `tokenCount` is redacted. A redacted
  metric is a nuisance; a logged bearer token is an incident, and those are not
  comparable costs.
- **Except at three characters, where over-matching stops being small.** `pan`
  as a substring redacted `span` — found in a real telemetry log line, not in a
  test — and would take `panel` and `expand` with it. Fragments of three
  characters or fewer now match a whole **segment**, split on separators and
  camelCase humps, so `pan`, `card_pan`, `cardPan` and `X-PAN` all still redact
  and `span` does not. Longer fragments keep the substring rule, because
  `access_token` and `oauthState` depend on it.
- **Only plain objects and arrays are traversed.** An `Error`, a `Date`, a
  `Map`, a `URL` is a **leaf**. Rebuilding one from its enumerable properties
  destroys it: `Error.message` and `.stack` are not enumerable, a `Date` has no
  own properties at all, and every one loses its prototype so `instanceof`
  returns false downstream. Both halves were live bugs found by running the
  logger — an error reached a log line with its message gone, and a `Date`
  arrived as `{}`. Traversal is for bags of fields, and a `Date` is not one.
  A null-prototype object still traverses, because a header map often is one.
- **`redactKeys` copies, never mutates.** It is called on the way to a log, and
  a scrubber that damaged the value being processed would be far worse than the
  leak it prevented.
- **A `Secret` is not comparable with `===`.** Two wrappers around equal values
  are different objects. Compare with `constantTimeEqual` on the exposed values
  — see [[random]] — and never with `===` on strings, which leaks by timing.
- **`mask` refuses to mask what it cannot.** A value short enough that the
  revealed tail would be most of it is hidden completely: a four-character PIN
  masked to its last two is not masked.
- **This protects printing, not memory.** It does not survive a heap dump, and
  it does not encrypt anything. It makes the accident impossible, which is the
  threat that actually happens.

## Used in

- `src/shared/redact/index.ts`
- `src/shared/redact/index.test.ts`

This list grows to every configuration value holding a credential, to
`AppError.details`, and to the logger's field scrubbing.

## Related

[[errors]] — `AppError.details` is printed by whatever logs the error, so a
secret belongs there only as a `Secret`. [[brand]] — a brand holding a
credential should wrap it; brands are erased and print as their base value.
[[assert]] — renders primitives into messages, which is safe for discriminants
and not for values. [[random]] — mints the tokens this wraps, and compares them
without leaking by timing. [[telemetry]] — where `span` turned out to contain
`pan`, which is how the segment rule got written.
