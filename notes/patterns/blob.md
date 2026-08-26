---
module: blob
layer: L2
---

# Blob — the key validation is the module

## What

Streaming object storage behind a port: `put`, `get`, `head`, `delete`, `list`.
A memory twin, a filesystem adapter, one contract suite both pass.

And a `BlobKey`: a value object that is constructed or throws, and the only
thing the store accepts.

## Why

### The keys matter more than the streaming

Streaming is a signature choice and it is easy: an export is arbitrarily large,
and `put(key, Buffer)` works until somebody exports a real dataset.

The keys are where the module earns its existence. **A key derived from user
input is a path traversal waiting for a concatenation**, and every object store
in the world takes a string. So a key is a value object, and nothing in this
module accepts a bare one.

### Tenant-scoped means the key ENCODES the tenant

Not that a filter applies one. The distinction is the whole security property: a
filter is a `where` clause somebody forgets, and the forgetting has no symptom
until a customer reads another customer's export.

A key that *begins* with the tenant cannot address another tenant's object
however the rest of it is built, because the prefix is not the caller's to
choose. The signature is what enforces it — `blobKey(tenant, ...parts)` is the
only constructor, and there is no way to build a key without one.

### An allow-list, and the deny-list that would have been wrong

`..` is one spelling. `%2e%2e`, `..%2f`, a UTF-8 overlong encoding and a
backslash are all traversal on some store, and each is a separate thing to
remember. The pattern has nothing to remember.

**The leading `[a-z0-9]` is what refuses `.` and `..`**, and it is the whole of
that rule — a relative segment starts with a dot, and a dot inside one
(`report.csv`) is untouched.

### Two things the breakage pass found

**A redundant guard.** An explicit `.` / `..` check sat below the pattern with a
comment claiming the pattern could not express the rule. Deleting it changed
nothing — the leading character already carried it. A redundant guard is not
free: it is a second place a rule appears to live, and the day somebody relaxes
the first character they will read the guard and believe they are covered.

**A swallowed refusal.** `get` and `head` computed the path *inside* their
`try`, so a containment refusal came back as `undefined` — a traversal attempt
was indistinguishable from a missing object, and nothing anywhere would ever
report one. Deleting the containment check failed no test, because the test was
asserting *absent* rather than *refused*. Both are fixed, and the test now
points at a file that actually exists outside the root.

### Filesystem, not S3, and that is a decision

`I2` asks for a real adapter passing the same contract as the twin, and the
property worth proving is that the port survives a store where writes land on
real bytes, reads stream, and a key is a path. A filesystem gives all three with
no account, no network and no credential — so `make test-integration` needs
nothing new and a fresh clone can run it.

S3 is the same port with a different `put`. Adding it is a file beside this one,
which is what `MODULES.md` §3 means by *a second service is a file, not a
redesign* — and the contract suite is what makes that true rather than hoped.

## Gotchas

**`realpath` catches what no string can.** A key can be perfectly valid and its
resolved path inside the root, and still point out of it — a symlink planted in
the tree. The string check and the `realpath` check are two defences against two
different things, and the integration suite plants a symlink to prove the second.

**The root itself may be a symlink, and on macOS it is.** `/var` links to
`/private/var`, so every `mkdtemp` path resolves somewhere the configured root
does not prefix — and the containment check rejected every write in the
temporary directory the tests use. The check was right; comparing a real path
against a possibly-symlinked root was wrong.

**Content type is stored beside the bytes, not guessed from the extension.**
Guessing is wrong for every file somebody names badly, and a store has no
business having an opinion about names.

**Absent is `undefined`, never an error.** A caller distinguishing *absent* from
*broken* through an exception is a caller that has to catch on the happy path.
A *refused* key is different and does throw — that distinction is the second
finding above.

## Example

```ts
const key = blobKey(tenant, 'exports', `${id}.csv`);
await blobs.put(key, rows, 'text/csv');
```

## Used in

- `tests/integration/blob/filesystem.test.ts` — the symlink, the large body, and
  the traversing key that arrived from outside the type system

## Related

- [[work]] — what runs the job that writes the object
- [[operations]] — what a caller polls, and which carries a reference to the
  object rather than the object
- [[tenant]] — the module whose scope this encodes rather than filters by
