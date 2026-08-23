---
module: crypto
layer: L3
---

# Crypto

## What

Keys, and the artefacts they produce.

```
v1.<kid>.<nonce>.<ct>   a ciphertext     AES-256-GCM
v1.<kid>.<tag>          a MAC tag        HMAC-SHA256
v1.<kid>.<sig>          a signature      Ed25519
```

Plus HKDF, for one ring serving several uses.

**The keyring is the module.** The primitives are library calls; what lives here
is the answer to *which key produced this, and how do I rotate without
invalidating history.*

The reason the shape matters more here than elsewhere: **the artefacts outlive
the code.** A design mistake is still in the database years later.

## Why

### Every artefact names its key

It reads like overhead until you try to rotate — and then it is the only thing
that makes rotation possible **rather than a migration**.

Without a key id in the artefact:

- decryption means trying every key on the ring, in order, until one works;
- a failure is indistinguishable from "we no longer hold that key";
- **no key can ever be removed**, because nothing knows what still depends on
  it. The ring grows forever and every retirement is a guess.

With one, decryption is a single lookup, a retired key is removable the moment
nothing names it, and a rotation audit is a `select distinct` over the key id.

This is the single design decision that makes the rest possible, and it is why
`keyIdOf`, `tagKeyId` and `signatureKeyId` exist — reading the id without
performing the operation is what an audit needs.

### Why AAD is required rather than defaulted

**The moved-ciphertext attack is not obvious, and a future contributor will be
tempted to add a convenience overload without it.**

Encrypting a column without binding it to its row means a ciphertext can be
**moved between rows undetected**. Swap two users' encrypted `email` values and
both decrypt *cleanly* — each returns the other's address, with no error
anywhere, no tag failure, and nothing in a log. The database is now quietly
wrong and no alarm exists that would fire.

So the AAD binds `tenant`, `table`, `id` and `field`. The field is in there
because two encrypted columns on **one row** can be swapped as easily as two
rows can.

An empty AAD *is* the failure, so `Binding` is a **required parameter** rather
than an optional argument with a default. A required parameter is the only
reliable way to make a caller think about it, and there is deliberately no
overload without one. If you are adding one, that is what this paragraph is for.

Verified by breaking it: replacing the AAD with an empty string turns four cases
red at once.

### Why one ring per purpose

It looks like ceremony at three rings, and it is the reason **a compromised MAC
key does not become a compromised signing key.**

Signing, encryption and MAC also rotate on different schedules — a signing key
is published and long-lived because verifiers hold it; an encryption key rotates
whenever policy says; a MAC key can rotate whenever you like because nothing
outside the process ever sees it. One key for everything forces the shortest
schedule on all three, or the longest, and neither is right.

### The ephemeral dev ring, and what is lost on restart

`ephemeralKeyring` generates a ring at boot. That is what lets `STORAGE=memory`
run with **nothing installed** — invariant `I1` again, the same argument as the
memory event bus and the memory mailer.

**Everything encrypted under it is lost on restart, and nothing signed by it
verifies afterwards.** A new ring means new keys, and the old ciphertexts name
key `dev` from a ring that no longer exists — so they fail with *no key "dev" in
the ring*, which is the honest error.

Somebody will hit this, which is why it is written here rather than left to be
debugged. The composition root **warns loudly at startup**, and `ephemeral` is
on the keyring so `doctor` and a health check can report it too. It is fine for
development and it must never be what production falls back to — which is why it
is an explicit constructor rather than a default when `CRYPTO_KEYS` is absent.

### Keys come from config, through secrets

`CRYPTO_KEYS=file:///run/secrets/keys` is a mounted Kubernetes secret and needs
**no new code** — `secrets` resolves the reference before `env` parses it, which
is exactly the seam that module exists for.

**Nothing prints a key.** Not in an error, not in a debug log, not truncated. A
keyset problem reports the *length* — `material is 8 bytes, expected 32` — and
never the bytes. The ring defines `toJSON` so an accidental `JSON.stringify`
produces ids, the same trick `Provenance` uses. The key id is loggable; the key
never is.

### Self-describing, and strict

`v1` costs four bytes now and is the difference between a **migration and a
rewrite** later — when the format changes, old artefacts still say what they
are.

Parsing is strict: anything this module did not produce is refused rather than
interpreted, and the value is never echoed in the error because it is a
ciphertext.

Every decryption failure gives **one message**. A wrong key, a tampered
ciphertext and a mismatched binding are indistinguishable to the caller, because
distinguishing them is an oracle. `Mac.verify` returns a bare `boolean` for the
same reason — a typed error would say which of the three was hit.

## Example

```ts
// The root builds the ring once, from a secret reference.
const keys = config.cryptoKeys === undefined
  ? ephemeralKeyring(random)          // dev only, and it warns
  : unwrap(parseKeyring(config.cryptoKeys.expose()));

if (keys.ephemeral) log.warn('ephemeral keyring — encrypted data is lost on restart');

const aead = makeAead(keys, random);

// The binding is required. There is no overload without it.
const sealed = unwrap(aead.encrypt(user.email, {
  tenant: subject.tenant, table: 'users', id: user.id, field: 'email',
}));
```

## Gotchas

- **Nonces come from the injected `Random`**, per rule `I5` — which also makes
  "two encryptions of the same plaintext differ" a real test rather than an
  assumption.
- **The AAD separator is ASCII unit separator, written as an escape.** A field
  containing it is refused, so the joined AAD is unambiguous rather than merely
  unlikely to collide. Writing it as a literal byte made the source file binary
  — the third time in this repository, caught by
  `tests/rules/encoding.test.ts` by name.
- **A signing key is stored as a 32-byte seed**, not a DER private key. The pair
  derives deterministically, so the same seed gives the same public key in Go,
  Python and here — which is what makes a signature cross-language verifiable.
  Cross-language vectors are worth adding once another blueprint has one.
- **Retired public keys stay published.** `publicKeys()` returns every key on
  the ring, because last year's signature is unverifiable otherwise.
- **`timingSafeEqual` throws on a length mismatch**, so length is checked first.
  A tag's length is not a secret; its bytes are.
- **HKDF uses no salt.** The input is already uniform key material rather than a
  password — RFC 5869 §3.1 — and a per-call salt would make derivation
  non-reproducible, which is the opposite of what a sub-key needs.
- **The `info` string is the separation.** Changing it invalidates everything
  derived under the old one, exactly as changing a key would.

## Used in

- `src/shared/crypto/index.ts`

This list grows to `identity` — challenge tokens, session fingerprints,
encrypted contact details — which is why `crypto` is built before it.

## Related

[[secrets]] — `CRYPTO_KEYS=file://…` resolves before `env` parses, with no code
here. [[redact]] — the same discipline about what must never print, and the
`toJSON` trick. [[random]] — the injected entropy nonces come from, per `I5`.
[[digest]] — the other place bytes must match across languages. [[classification]]
— which fields are worth encrypting is *its* vocabulary, not this module's
decision.
