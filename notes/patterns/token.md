---
module: token
layer: L0
---

# Token — mint a secret, store its shadow

## What

Four functions. `mintSecret` draws 256 bits from an injected `Random` and
returns the raw value **and** its `sha256:` fingerprint. `fingerprintOf` and
`secretMatches` are the one-way step and its constant-time comparison. `bind`
joins the parts a MAC is computed over.

That is the whole module. It has no state, no I/O and no domain.

## Why

### The store never holds a usable token

A database dump yields no sessions, no API keys, no challenge secrets and no
invitations, because none of them is written. Conformance case 16 says an API
key is shown once and never returned again, and that is only true if it
**cannot** be returned.

### The third context is what promoted it

It lived in `identity/app/tokens.ts` and was correct there. Then `orgs` needed
the identical mechanics for an invitation, and `S6` makes a context's code
unreachable from the next one — so the choice was a second copy or a shared
module, and the collection's rule is that the **second copy** is the trigger,
not the third caller.

The alternative that lost: leave it in `identity` and have `orgs` write its own.
Two implementations of *mint, fingerprint, compare* drift, and the one that
drifts is the one that stores a token raw — which is a silent failure that looks
exactly like working software until somebody reads a table.

### What could NOT be promoted, and why that is the more interesting half

`CONTEXTS.md` §4 calls an invitation *the `Challenge` shape again*, so the
obvious move is to promote `Challenge` itself. **That is not possible, and the
rule that forbids it is right.**

`S7` permits a context's `domain/` exactly one import: `errors`. No shared
module is reachable from where an aggregate lives. So an aggregate cannot be
shared between contexts, by construction.

Two readings, and the second is the correct one:

- *The rule is in the way.* It is not. An aggregate **is** a context's model of
  its own world, and two contexts sharing one would be two contexts with one
  model — which is the coupling the island rule exists to prevent. If `orgs` and
  `identity` shared a `Challenge` class, a change to one context's expiry rules
  would be a change to the other's.
- *The mechanics were in the wrong layer to begin with.* Also true, and it took
  a second consumer to see it: a MAC tag and a fingerprint are not domain
  concepts, and `identity` had put them next to one.

So `orgs` has its own `Invitation` aggregate — different fields, different
rules, an org rather than a user as its subject — and both contexts compute
their secrets with this module. The shape is reused; the model is not shared.

**This was built as a special case the first time.** Not knowingly: `identity`
was the only context that existed, and a helper beside its only caller is the
right size until there are two. The finding is about how it looked from inside
one context, which is that a mechanism and a special case are indistinguishable
until something else needs the mechanism.

## Gotchas

**`bind` is a join with a separator that cannot occur in its parts** — U+001F,
written as an escape and never as a literal byte. A raw control character makes
a file binary to every text tool: `grep` skips it, an editor eats it, and the
only thing that catches it is `tests/rules/encoding.test.ts`. This repository
has written one by accident five times.

**Binding every part is the point, and dropping one is the classic bug.**
Without the purpose in the MAC, a password-reset secret and a magic-link secret
are interchangeable and the weaker flow becomes the way into the stronger one.
Without the subject, a token can be moved between accounts — or, now, between
organizations.

**A plain SHA-256, deliberately, and not a password hash.** A password is
low-entropy and needs a work factor to survive a dump; a 256-bit random token is
not guessable, and a memory-hard hash on the **per-request** session lookup is a
self-inflicted denial of service. The two look like the same problem and are
not.

**`secretMatches` is constant-time for a narrower reason than it looks.** The
lookup is by fingerprint through an index, so the database has already leaked
timing by finding the row or not. This closes the remaining comparison and costs
nothing — it is not the thing standing between you and an attacker.

## Example

```ts
const secret = mintSecret(random);
await store.save({
  fingerprint: secret.fingerprint,
  tag: mac.sign(bind(id, orgId, 'org_invitation')),
});
await mailer.send(to, secret.raw); // the only time it exists
```

## Used in

- `src/contexts/identity/app/tokens.ts` — re-exported, so this context's call
  sites keep naming what they use
- `src/contexts/orgs/app/command/invitations.ts` — the same mechanics over an
  organization rather than a user

## Related

- [[crypto]] — supplies the MAC that `bind`'s output is signed with
- [[digest]] — the `sha256:` fingerprint
- [[random]] — where the entropy comes from, injected rather than reached for
- [[identity]] — the first implementation, and where this lived
- [[orgs]] — the second consumer, and the reason this is a module
