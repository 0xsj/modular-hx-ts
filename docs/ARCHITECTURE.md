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

## To be completed as the repo is built

Every shared module with its layer · every context with its responsibility ·
data flow for a command, a query and an event. **Rule R2 requires all three.**
