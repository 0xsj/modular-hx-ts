---
module: id
layer: L0
---

# Id

## What

UUIDv7 behind a port. `IdGenerator.uuid()` returns a `Uuid` — a branded,
canonical, lowercase string. `systemIds(clock, randomBytes)` is the real
implementation; `fakeIds(clock)` produces a readable sequence a test can write
down. `timestampOf` recovers the instant an id encodes, `parseUuid` validates an
untrusted one, and `sequencer` makes `usr_000001`-style ids for seed data.

Invariant I5: **time, randomness and identifiers are injected.** Both halves
arrive as arguments — `systemIds(clock, randomBytes)` defaults neither and
touches no platform API. `systemClock` is the adapter for time and
`systemRandom` is the adapter for entropy; this module is neither, it composes
them. Rules `M2` and `I5` enforce that.

## Why

### Why a port at all

A module that mints its own ids cannot be tested for *what* it stored, only that
it stored something. Every assertion becomes `expect.any(String)`, and the test
that would have caught the wrong id being written is the one you cannot write.

### Why v7 rather than v4

UUIDv7 is a 48-bit millisecond timestamp followed by randomness, so ids sort by
creation time both as strings and as bytes. Three things follow, and only the
first is cosmetic:

- **Ids read in creation order** in a log or a `psql` window.
- **A B-tree does not fragment.** Random v4 keys insert uniformly across the
  index, so every insert dirties a different page and the index grows far larger
  than the data it covers. v7 appends to the right-hand edge.
- **Keyset pagination over the id column is meaningful.** `WHERE id > $cursor
  ORDER BY id` is a chronological page. With v4 it is an arbitrary one, and
  [[pagination]] would need a separate sort key.

### Why the counter matters

RFC 9562 §6.2 method 1. Within one millisecond the timestamp is identical, so
plain v7 falls back to randomness and two ids minted in the same millisecond
sort arbitrarily. Replacing the twelve `rand_a` bits with a counter keeps the
ordering — and the case where this matters is a burst of inserts, which is to
say **under load**, which is exactly when nobody is watching.

The counter is seeded randomly per millisecond rather than at zero, so an id
does not publish how many were minted alongside it.

**Rejected: UUIDv4.** No ordering, and the index fragmentation above is a real,
measurable cost that shows up long after the decision is cheap to reverse.

**Rejected: ULID.** Same time-ordered idea, different alphabet, and it is not a
UUID — so `uuid` columns, `uuid_extract_timestamp()`, and every driver's native
type stop applying. v7 gets the same property inside the standard.

**Rejected: a database sequence (`bigserial`).** Requires a round trip before an
aggregate has an identity, which means the domain cannot construct a complete
object without touching the database. It also leaks volume: `id=41827` tells a
customer how many rows exist.

## Example

```ts
// Injected, and faked in tests like any other dependency.
export function makeRegisterUser(ids: IdGenerator, clock: Clock) {
  return (email: Email): User => ({
    id: ids.uuid(),
    email,
    createdAt: clock.now(),
  });
}

// A test can name the exact id, because the fake is deterministic.
const clock = fakeClock();
const register = makeRegisterUser(fakeIds(clock), clock);
expect(register(email).id).toBe('019b76da-a800-7000-8000-000000000000');
```

## Gotchas

- **The counter wraps at 4096 ids per millisecond.** Past that, ordering within
  that millisecond is lost. It is a tested boundary rather than a surprise, and
  four million ids a second is not this blueprint's problem — but if it becomes
  yours, the RFC's method 2 trades random bits for a wider counter.
- **A v7 id publishes when it was created.** That is usually a feature and
  occasionally a leak: an invitation token or a password-reset id built on v7
  tells the holder exactly when it was issued. Those want [[random]], not this.
- **`sequencer` is for seed data and fixtures only.** Guessable, leaks volume,
  and needs coordination to stay unique across processes. It exists because a
  reader holding two ids in their head cannot tell `01a024c7-…` from
  `01a024c8-…` at a glance.
- **`fakeIds` still emits structurally valid v7s** — correct version and variant
  bits, only the randomness zeroed. A fake whose output the real parser would
  reject hides bugs rather than exposing them.
- **`parseUuid` lowercases and trims.** The same id arriving uppercase from one
  client and lowercase from another is one id, and a unique index will not
  agree. Normalize at the boundary or store both.
- **`timestampOf` returns a `Result`.** The embedded timestamp is meaningless
  for any other UUID version, and a plausible wrong `Date` is worse than a
  refusal. Postgres 18 exposes the same thing as `uuid_extract_timestamp()`.
- **`RandomBytes` is declared here, not imported**, and it is required rather
  than defaulted. `../ARCHITECTURE.md` §1.1 puts an interface in the consumer
  that needs it, which is why it was declarable before [[random]] existed —
  `random.bytes` now satisfies it unchanged. It has no default because a default
  would be a hidden dependency on the platform CSPRNG inside the one module
  whose job is to have none, and it would force an exemption in rule `I5`.

## Used in

- `src/shared/id/index.ts`
- `src/shared/id/index.test.ts`

This list grows to every aggregate that has an identity, and to the event
envelope, where the event id is the idempotency key every subscriber keys on.

## Related

[[clock]] — where the timestamp half comes from, and the reason ids are ordered
at all. [[brand]] — what makes `Uuid` a distinct type from `string`.
[[random]] — supplies `RandomBytes`, and is the right choice for a token
that must not encode its own creation time. [[pagination]] — keyset cursors,
which a v7 id column makes chronological. [[errors]] and [[result]] — how a
bad id is refused.
