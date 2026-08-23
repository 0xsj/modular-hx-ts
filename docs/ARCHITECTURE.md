# Architecture — modular-hx-ts

**This document is a delta.** The architecture is specified in
`../../ARCHITECTURE.md`; only what is specific to this repo appears here.

- **Part I invariants** apply unchanged. They are never overridden.
- **Style:** ARCHITECTURE.md Part II — no deltas. Sibling to `modular-hx-go`.

## Deltas from Part II

**None.** This repo *is* the default style. Where this document is silent, Part II
applies verbatim.

## Layout

```
src/shared/<module>            L0 → L4, layered. A module imports only strictly lower layers
src/contexts/<context>/
    domain/                   entities, value objects, invariants, events — imports only `errors`
    app/command|query|subscriber
    infra/memory|postgres
    transport/http
src/wire.ts                    composition root
```

## System diagram

```
        ┌──────────────────────────────────────────────────────┐
        │  COMPOSITION ROOT — knows concrete types             │
        └───────────────┬──────────────────────────────────────┘
                        │ constructs · injects
        ┌───────────────▼────────────┐   ┌───────────────────┐
        │  CONTEXTS (hexagonal)      │──▶│  SHARED KERNEL    │
        │  identity · audit · orgs   │   │  L0 → L4, layered │
        │  never import each other   │   │  no domain        │
        └────────────────────────────┘   └───────────────────┘
                        │ domain events only
                        ▼
                 ┌─────────────┐
                 │  bus / log  │  at-least-once · idempotent consumers
                 └─────────────┘
```

## Shared modules, by layer

`layers.cjs` is the machine-readable source of this table — rule `S1` turns it
into the import graph and `N7` checks every module note names the same layer.
This section is the human copy; if they disagree, `layers.cjs` is right and this
is stale.

**A module imports only strictly lower layers.** Same-layer imports are allowed
and flagged in review, never by a test.

| Layer | Intent | Modules |
| --- | --- | --- |
| **L0** kernel | Pure. No I/O, no process state. Runs with no fixtures and no infrastructure | `errors` · `result` · `brand` · `assert` · `clock` · `id` · `random` · `retry` · `breaker` · `digest` · `pagination` · `buildinfo` · `redact` |
| **L1** runtime | Describes this process, not the domain | `provenance` · `logger` · `env` · `secrets` · `lifecycle` · `health` · `telemetry` |
| **L2** substrate | I/O. Port + memory adapter + real adapter + one contract suite both pass | `postgres` · `events` · `jobs` · `lock` · `mailer` · `httpclient` |
| **L3** capability | Makes a real decision, knows no domain | `authz` · `tenant` · `crypto` · `classification` · `flags` |
| **L4** edge | Speaks a wire protocol | **`edge`** · `httpx` · `idempotency` · *(pending: `ratelimit` · `conditional` · `openapi`)* |
| **L5** | Composition root — the only place that knows concrete types | `src/main.ts` |

### `postgres` is the L2 exception, and the only one

It is **not** a port with two implementations. It is what the real
implementations are built on, and its memory counterpart does not exist because
a memory repository does not use it — `STORAGE=memory` never reaches it. Rule
`M1` applies to the repositories above it, never here, and there is no fake
pool.

Two interfaces do the swapping and `postgres` is neither:

- **`DB`** (`query` · `queryRow` · `exec`) — what a **repository** depends on.
  Declared in `postgres`, satisfied by **both a pool and a transaction**, and
  named in SQL and parameters so changing the query layer changes no repository
  signature.
- **`Transactor`** (`withinTx`) — what a **use case** depends on.
  **Consumer-declared in `app/`**, never imported from here: an application
  layer that imported `postgres` to say "these writes are atomic" would have
  inverted nothing. `postgres` declares the shape internally only to assert at
  compile time that the pool still satisfies it.

The transaction travels **in the signature**, not on the ambient context —
ADR 0008, and a deliberate fork from siblings that chose the other shape.

### `edge` is the floor of L4, and carries the layer's name

`../ARCHITECTURE.md` §L4 names it. The chain vocabulary — the handler and
middleware types, and eventually the response writer that records whether it has
been committed — sits **below** the rest of L4: `httpx` assembles the chain,
`idempotency` and `ratelimit` and `conditional` are positions in it, and every
one of them needs the types to be written at all.

Same shape as `errors` under L0, and the name follows the same rule: it is the
layer's vocabulary, so it carries the layer's name.

**The reason it is framework-neutral is specific to this blueprint.** Two
servers — `node:http` and Fastify — run the same chain behind one port, and the
adapter suite runs every case through both and compares the two answers to each
other. A chain written against either framework's request type could not do
that.

The ordering is enforced by convention rather than by the cruiser: `S1` cannot
tell a floor import from a peer import, because both are same-layer. What the
floor buys is that the peer import nobody should make — `idempotency` → `httpx`
— is now visibly different from the one everybody makes.

### `testx` is not a module and has no layer

`tests/testx/` is the integration-test harness (`../MODULES.md` §3: *not a peer
module and not a one-shot*). It lives under `tests/` rather than `src/shared/`
so it never ships, `S3` needs no argument about it, and it is absent from
`layers.cjs` on purpose. It grows as substrate lands — Postgres now, Redis with
`cache`, SMTP with `mailer`.

## To be completed as the repo is built

Every context with its responsibility · data flow for a command, a query and an
event. **Rule R2 requires those alongside the module table above**, which is why
`R2` stays in `docs/TREE.md` → *Rules not yet enforced* until contexts exist.
