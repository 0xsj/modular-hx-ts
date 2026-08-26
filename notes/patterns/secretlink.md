---
module: secretlink
layer: L3
---

# Secretlink — the wire half of an out-of-band secret

## What

An emailed link, as three parts on the wire: `<id>.<secret>.<tag>`. Issue one,
parse one back, check the tag before touching the database, compare the secret
against a stored fingerprint in constant time.

Four functions and no state. **No clock, no TTL, no purpose, no single-use.**

## Why

### Two modules, and the split is not cosmetic

`token` is the primitive: mint a bearer secret, keep only its digest, compare by
digesting. **Sessions and API keys need exactly that** — no MAC, no identifier
on the wire, no journey outside the system. It is pure, so it sits at L0.

**This is the layer above**, for values that leave and come back: password
resets, magic links, invitations. It needs `crypto`, so it cannot be at L0.

One module doing both was the tempting shape and it is worse in two ways: every
session would carry link machinery it never uses, and a reader could not tell
which half a caller depends on. The layer boundary makes the second one
structural — a module at L0 *cannot* have a MAC in it.

### The MAC is not decoration

Without it, an identifier on the wire is an identifier an attacker can forge and
probe against the table: one request per guess, and the answer is whether the
row exists. `authentic()` refuses a forged id **by arithmetic, before the
database is touched**.

That is why the wire tag binds **the id and nothing else**. Binding a subject or
a purpose would make it unverifiable from the wire value alone, because neither
is known until the row is read — and then the check would happen after the
lookup it exists to prevent.

### Two tags, two threats, and neither does the other's job

A caller that also wants *this row was not tampered with* keeps a **second** tag
over its own fields — org, email and role for an invitation; user and purpose
for a challenge — stored beside the row and checked after the lookup.

Both contexts do exactly that, and the division is the same one this module is
built on: the wire tag is a mechanism and lives here; the stored tag binds
**domain values** and lives with the aggregate that owns them.

### What must not travel

`CONTEXTS.md` §4 calls an invitation *the `Challenge` shape again*, which makes
promoting the whole aggregate look obvious. It is not possible and it should not
be: `S7` permits a context's `domain/` exactly one import, `errors`, so no
shared module is reachable from where an aggregate lives.

That is the rule working. **TTL, single-use and purpose are rules**, and a rule
belongs to the model that owns it — two contexts sharing one aggregate would be
two contexts with one model, and a change to `orgs`' expiry would be a change to
`identity`'s.

The collection brief names the signal exactly: *if you find yourself wanting a
clock inside either module, that is the signal you are moving the wrong half.*
There is no clock in either, and a test asserts it by reading the source.

## Gotchas

**A tag contains dots.** `crypto` spells one `v1.<kid>.<tag>`, so an exact
three-way split on `.` refused every link this module issues. `parse` takes two
parts from the front — a UUID and a base64url secret are dot-free by
construction — and gives the tag everything after the second separator. The
first read-back test caught it, which is the argument for writing that test
first.

**This module exports no refusal, and the first version did.** A context that
used it for *malformed* while keeping its own for *expired* said two different
things — which is precisely the enumeration oracle conformance case 13 forbids,
**introduced by the extraction itself** and caught by the test asserting the two
are identical. A refusal message belongs to the surface that answers, not to the
mechanism, so every function here returns `undefined` and there is nothing to
spell differently.

**`matches` is constant-time for a narrower reason than it looks.** The row was
found by id, so the database has already leaked whether it exists. This closes
the remaining comparison and costs nothing; it is not the thing standing between
you and an attacker — the tag is.

**The store never holds a usable value.** `issue` hands back a token and a
fingerprint, and only the fingerprint is meant to be written. That is what makes
conformance case 16 true rather than aspirational: a key shown once must be one
that *cannot* be returned.

## Example

```ts
// Issue — the token is emailed once and never stored.
const link = unwrap(issue({ id, random, mac }));
await store.create({ id, fingerprint: link.fingerprint, tag: contentsTag });
await mailer.send(address, link.token);

// Consume — authenticate, then look up, then compare.
const presented = readable(token, mac);
if (presented === undefined) throw refused();      // forged id, or malformed
const row = await store.byId(presented.id);
if (row === undefined) throw refused();
if (!matches(presented, row.fingerprint)) throw refused();
if (!mac.verify(contentsOf(row), row.tag)) throw refused();  // tamper check
```

## Used in

- `src/contexts/identity/app/command/challenges.ts` — verify email, reset
  password, change email, magic link
- `src/contexts/orgs/app/command/invitations.ts` — the same mechanism over an
  organization

## Related

- [[token]] — the primitive underneath: mint, fingerprint, compare
- [[crypto]] — the keyring-aware MAC, so rotation does not break links already
  in a mailbox
- [[identity]] — the first consumer, and where this shape was written first
- [[orgs]] — the second, which is what made it a module
