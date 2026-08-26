---
module: openapi
layer: L4
---

# Openapi — generated, committed, diffed

## What

`make openapi` walks `httproute`'s route values and writes `docs/openapi.json`.
`make ci` regenerates and fails when the committed file differs.

Two functions: `generate(routes, info)` builds the document, `render` turns it
into the bytes that are committed.

## Why

### Three words, and only the first is easy

`MODULES.md` says *a spec generated from the schemas handlers use, committed,
diffed*. Each is load-bearing and they fail differently.

**Generated.** This touches no handler. A route already carries its method, its
path, its body schema, its declared responses and whether it needs a
credential — everything a document needs is a property of a value that already
exists. **If a handler had to be annotated to make the generator work, the
registry would be missing something and that would be the bug.**

**Committed.** A spec that exists only at runtime cannot be reviewed, diffed or
handed to anybody, which is most of what a spec is for. It is a file.

**Diffed.** Without this the module is decoration: a schema change would alter
the published contract and ship quietly. `make ci` runs `--check`, and a
deliberate break — adding one optional field to a request body — fails it.

### It inherits S11, which makes it unusually honest

Every route declares the statuses it can answer, and `tests/rules/routes.test.ts`
proves the declaration covers what the chain can produce. So this document is
not a description of what somebody believed the routes did. **Anywhere it is
wrong is a real gap in a declaration**, and the same rule test that catches the
gap catches it before the document is published.

### Determinism is the property the drift check is built on

A generator whose output depends on the order routes were registered in cannot
be diffed — the check fires on every unrelated change until somebody deletes it,
and deleting it is how this becomes decoration. Routes are sorted by path then
method and every object is built in a fixed key order, and two tests assert it:
identical bytes from a reordered input, identical bytes from two runs.

### The two global statuses are documented even though S11 exempts them

`ENFORCEMENT.md` S11 exempts `500` and `503` from the per-route declaration,
because repeating them everywhere makes the declaration unreadable. **That
exemption is about where the truth is written, not about whether it is
published.** A document is read by a client, and a client that has not been told
about `500` treats one as a protocol error. So the generator adds them.

### The parking reason, and why it expired

Every blueprint parked this with the same sentence: *the generator and drift
check are testable against a fake route today, but with no handlers there is
nothing to demonstrate the guarantee on.* That was right. Three contexts, ten
normative routes, schemas on the registry and S11 enforcing the response set is
the precondition, satisfied twice over.

## Gotchas

**`:id` and `{id}` are two spellings of one thing, and only one is stored.** The
registry spells a parameter the way a router matches it; OpenAPI spells it the
way a template does. Converting at generation keeps one authoritative — storing
both would drift, and the one that drifted would be the published one.

**`z.null()` is *no body*, not *a null body*.** A 204 with
`{ schema: { type: 'null' } }` promises a body that happens to be null, which is
a different promise from having none. The generator omits `content` entirely.

**`security: []` is not the same as omitting `security`.** An empty array says
*no credential required*; omitting the key says *inherit the document default*.
Anonymous routes get the array.

**`operationId` is derived, never maintained.** A hand-written one is a second
name for a route, and the second name is the one that goes stale. Client
generators key on it, so it is a function of the route rather than of its
position in a file.

**The `info.version` is the contract's, not the build's.** A version that moved
on every commit would make every build a diff, which would make the drift check
always fire — and a check that always fires is a check nobody reads.

**The probes are absent.** `/healthz` and `/readyz` are the composition root's
own, not any context's route table, so the generator never sees them. That is
right for a document describing the API and worth knowing before somebody looks
for them.

**zod 4 converts its own schemas.** No converter dependency to keep in step with
the validator — which matters more than the saved install: a converter that lags
the validator publishes a contract the server does not enforce.

## Example

```
$ make openapi
openapi: wrote docs/openapi.json (22 paths)

$ make openapi-check
openapi: the committed spec matches the registry
```

## Used in

- `tools/openapi.ts` — the command, and the `--check` `make ci` runs
- `docs/openapi.json` — the committed artifact, 22 paths and 29 operations

## Related

- [[httproute]] — the registry this walks; the declarations are its
- [[edge]] — where a route's handler type lives, and which this deliberately
  does not import
- [[conditional]] — supplies the ETag semantics the document's 304s describe
