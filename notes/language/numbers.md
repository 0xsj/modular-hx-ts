---
topic: javascript numbers
---

# Numbers, and the one type there isn't

## What

JavaScript has **one** number type — an IEEE-754 double — plus `BigInt` for
arbitrary integers. There is no `int64`, no `int32`, and no decimal.

In a collection whose thesis is that the language is the only variable, this is
the single largest place where TypeScript and Go are genuinely not
interchangeable. Go's `int64` is the natural type for a Postgres `bigint`, an
advisory lock key, and a monotonic counter. Here every one of those needs a
decision.

| Thing | Go | Here |
| --- | --- | --- |
| Postgres `bigint` | `int64` | `string` from the driver, or `BigInt` |
| Advisory lock key | `int64` | `BigInt`, converted at the call |
| A count | `int` | `number` — safe below 2^53 |
| Money | minor units in `int64` | minor units in `number`, or a string |
| A timestamp | `time.Time` | `Date` — milliseconds, not microseconds |

## Why

### 2^53, and where this repository actually touches it

`Number.MAX_SAFE_INTEGER` is 9007199254740991. Above it, integers stop being
exact and `x + 1 === x` becomes possible. Three places here go near it:

**Advisory lock keys.** `pg_advisory_lock` takes a signed 64-bit integer, and
`lock` derives one by hashing:

```ts
const unsigned = BigInt('0x' + digest.slice(7, 23)); // first 8 bytes
return unsigned >= 2n ** 63n ? unsigned - 2n ** 64n : unsigned;
```

`BigInt` throughout, converted with `.toString()` at the query boundary because
the driver wants text for a `bigint` parameter. Doing this in `number` would
silently collide keys that differ only in their low bits.

**Postgres `bigint` columns.** `pg` returns them as **strings**, deliberately,
for exactly this reason. It looks like a driver quirk and is the correct
default — a count read as `number` is fine, and an id read as `number` is a
latent bug. `select count(*)::text` in the outbox is the same instinct made
explicit.

**RFC 8785 digests.** Canonical JSON serialises numbers with `String(n)`, which
is exact for every double — including `1e+21` and `-0` → `"0"`. The `integers`
cross-language vector pins `max_safe` at 9007199254740991 precisely because that
is the last value all three languages agree on without ceremony.

### `Date` is milliseconds; Postgres is microseconds

A `timestamptz` round-trip keeps microsecond precision in the database and loses
it in a `Date`. The storage-behaviour suite asserts both halves separately: the
column keeps `.123456` when read back as text, and the driver hands back a
`Date` at the same **instant** to the millisecond.

That is not a bug to fix — it is a difference to know. Anything needing
sub-millisecond precision has to stay a string on the way through.

### `Millis` is a brand, not a type

There is no duration type, so `clock` brands one. `Millis` is a `number` at
runtime, which is why arithmetic on it works and why `since(clock, start)`
returns one rather than exposing raw subtraction. See [[type-system]].

### Division and modulo are float operations

`5 / 2` is `2.5`, not `2`. Every integer division here is explicit —
`Math.floor(job.period / 4)` for jitter, `Math.round(since(...))` for a
duration in whole milliseconds. A stray non-integer reaching a `bigint`
parameter or an index is a runtime error at the database rather than a compile
error here.

## Gotchas

- **`BigInt` and `number` do not mix.** `1n + 1` throws. Conversions are
  explicit and that is a feature: the places they meet are exactly the places
  precision can be lost.
- **`JSON.stringify` cannot serialise a `BigInt`** — it throws. An advisory key
  never reaches a payload, and if one ever must, it goes as a string.
- **`pg` returning `bigint` as a string is correct.** Do not "fix" it with a
  type parser. A `count(*)` cast to text and wrapped in `Number()` at the call
  site is the honest version, and it is what `outbox.pending()` does.
- **`Number('')` is `0`, and `Number(undefined)` is `NaN`.** An env reader that
  used `Number` directly would turn an unset variable into a valid-looking zero;
  `env`'s `integer` reader checks the string first.
- **`-0` exists and `String(-0)` is `"0"`.** RFC 8785 requires exactly that, so
  the canonical form gets it free — but `Object.is(-0, 0)` is `false`, so a test
  comparing with `toBe` can fail on a value that prints identically.
- **`0.1 + 0.2 !== 0.3`.** Money is minor units, everywhere, and a monetary
  amount that must survive exactly is a string in transit.

## Used in

- `src/shared/lock/key.ts`
- `src/shared/digest/index.ts`
- `src/shared/clock/index.ts`
- `src/shared/events/outbox/index.ts`

## Related

[[type-system]] — `Millis` and the other brands, which is how a number gets a
meaning. [[digest]] — `String(n)` being exactly what RFC 8785 asks for.
[[stringification]] — the other half of that, for strings and key order.
[[lock]] — the advisory key, and why it is `BigInt` end to end. [[postgres]] —
`bigint` arriving as a string.
