# modular-hx-ts

The same architecture where the *language* is the variable and nothing else is.
If `modular-hx-go` and this repo satisfy the same conformance suite while looking
different inside, the architecture is not Go-shaped. That is the claim this repo
exists to test.

> **Status: not yet built.** Scaffolding only. See `docs/TREE.md` for the build
> queue and `docs/decisions/0001` for the architecture choice.

## What this is

A **blueprint** — a complete, runnable reference implementation you clone as the
starting point of a real product. Not a sample, not a demo.

- **Architecture:** hexagonal · **Language:** TypeScript · **Framework:** node:http + fastify (both, behind one port)
- **Storage:** postgres

## The four acceptance criteria

1. `STORAGE=memory` runs the whole application with **zero external dependencies**.
2. Architecture rules are enforced as tests, not documented as intentions.
3. The verification ladder holds: unit → integration against real infrastructure
   → e2e against the real binary.
4. The `notes/` corpus exists and is enforced. **A module without a note does not
   ship.**

## Layout

```
src/shared/          the layered shared kernel (L0 → L4)
src/contexts/          bounded contexts — never import each other
src/wire.ts          composition root — knows concrete types, imported by nothing
docs/                ARCHITECTURE · TREE · decisions
notes/               language · patterns · domain · techniques
```

## Documentation

| | |
| --- | --- |
| `docs/TREE.md` | The build queue. **The first unticked box is what happens next** |
| `docs/ARCHITECTURE.md` | This repo's delta from the collection architecture |
| `docs/decisions/` | ADRs |
| `../` | The collection specification |
