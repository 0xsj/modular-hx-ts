---
module: random
layer: L0
---

# Random

## What

One CSPRNG behind a port. `Random` has `bytes`, `token` and `int`;
`systemRandom()` is backed by `crypto.getRandomValues`, `fakeRandom(seed)` is a
deterministic stream for tests. `constantTimeEqual` compares two secrets without
leaking where they differ.

Invariant I5: **time, randomness and identifiers are injected.** `systemRandom`
is the one implementation permitted to call the platform CSPRNG.

## Why

### One module, so there is one place to review

Randomness scattered across a codebase is how `Math.random()` ends up minting a
password-reset token. Nobody decides that; it happens because a developer needed
a random number, reached for the obvious thing, and no reviewer connected that
line to the security property three files away. A single module makes "where
does entropy come from" answerable, and makes `Math.random()` anywhere else
visible as an anomaly rather than an idiom.

### Unbiased integers

`draw % max` is the one-liner everyone writes and it is biased: 2^32 is not a
multiple of most bounds, so the low residues come up slightly more often. For a
dice roll nobody notices. For a shard assignment, a sampling decision, or a
six-digit one-time code, the skew is real and stays invisible until somebody
measures it — so the test measures it.

Rejection sampling instead: discard draws in the ragged tail above the largest
multiple of `max`. Expected draws under 2, terminates with probability 1.

### Constant-time comparison

`a === b` on strings stops at the first differing byte. How long the comparison
took therefore tells an attacker how much of their guess was correct, and with
enough samples that turns forging a session token or an HMAC from a 2^256
problem into a 32-step one, byte by byte. Every comparison of a secret goes
through `constantTimeEqual`.

**Rejected: hand-rolling the XOR accumulator.** The loop is four lines and
correct on paper, and then it is at the mercy of whatever the JIT does with it —
early exit, vectorisation, hoisting. `node:crypto`'s `timingSafeEqual` is
maintained by people who think about that; this module wraps it. This is the one
place where "write it yourself so it is inspectable" is the wrong instinct.

**Rejected: `crypto.randomUUID()` for tokens.** It is a v4 UUID: 122 bits of
entropy in a fixed 36-character shape that announces what it is. `token()` gives
256 bits in 43 URL-safe characters, and is not mistakable for a row id.

## Example

```ts
// Injected, like the clock and the id generator.
export function makeIssueSession(random: Random, ids: IdGenerator) {
  return (userId: UserId): Session => ({
    id: ids.uuid(),
    secret: random.token(),      // 256 bits, URL-safe
    userId,
  });
}

// Verification never uses ===.
if (!constantTimeEqual(presented, stored.secret)) {
  return err(unauthenticated('session token does not match'));
}
```

## Gotchas

- **`fakeRandom` is not random.** xorshift32, fully predictable, and that is the
  point — a test can assert on an exact token. The `Random` port and a
  composition root that wires `systemRandom` are what keep it away from anything
  that mints a real secret. It is worth grepping for before a release.
- **`constantTimeEqual` does not hide length.** Different lengths return `false`
  immediately. That is the accepted trade — `timingSafeEqual` throws on a length
  mismatch, and a comparison that throws is one somebody wraps in a `try` and
  gets wrong — and it is safe only because token lengths here are fixed and
  public. Never use it where the length is the secret.
- **Do not build a secret on a [[id]] v7 value.** A v7 id encodes its creation
  time, so an invitation token or a password-reset id built from one tells the
  holder exactly when it was issued, and narrows a brute-force window. Ids
  identify; tokens authenticate; they are different modules for that reason.
- **`bytes` is chunked at 65,536.** The platform refuses a larger single draw.
  Without chunking a big token throws, and only in production.
- **A bad argument throws `Internal`, not `Invalid`.** `bytes(-1)` and `int(0)`
  are bugs, not user input, so they go through [[assert]] rather than returning
  a `Result` nobody can act on.
- **`token()` defaults to 32 bytes** — 256 bits, the size below which nobody has
  to think about it. Shorten it only with a reason written down.

## Used in

- `src/shared/random/index.ts`
- `src/shared/random/index.test.ts`

This list grows to every session, API key, invitation and reset token, and to
[[id]], whose `RandomBytes` interface this satisfies.

## Related

[[id]] — declares `RandomBytes`, which `bytes` implements; and the note on why
an id is not a secret. [[clock]] — the other injected source, and the same
system/fake shape. [[assert]] — where a bad argument goes. [[digest]] — content
addressing, which is deterministic hashing rather than randomness, and is often
confused with it. [[crypto]] — the L3 keyring, which uses this for key material
and nonces.
