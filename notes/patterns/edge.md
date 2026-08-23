---
module: edge
layer: L4
---

# Edge — the L4 floor

## What

The chain vocabulary: `Request`, `Response`, `Exchange`, `Handler`,
`Middleware`, `Reporter`, and the `json`/`text` helpers. Types and two
constructors. No behaviour.

**The floor of L4** — `../ARCHITECTURE.md` §L4.

## Why

### A layer whose members share a type needs somewhere below them to put it

`httpx` **assembles** the chain. `idempotency`, `ratelimit` and `conditional`
are **positions in** it. All four need the same handler and middleware types in
order to be written at all.

Left inside `httpx`, every other L4 module imports a peer. `S1` permits that and
review is supposed to catch it — which turns a flag meant to catch something
into one that fires on every module in the layer, and a flag that always fires
stops being read. In the floor, the dependency points downward like every other.

This is the same shape as L0's vocabulary, one layer up, for the same reason:
`errors` and `result` sit under the rest of L0 and import nothing, so `clock`
importing `errors` is ordering rather than entanglement.

**It is ordering, not enforcement, and that is worth being clear about.** The
cruiser cannot tell a floor import from a peer import — both are same-layer.
What the floor buys is that the peer import nobody should make (`idempotency` →
`httpx`) is now visibly different from the one everybody makes (`idempotency` →
`edge`), rather than the two being indistinguishable.

`edge` is listed **first** in the L4 block of `layers.cjs` for the same reason
`errors` is listed first in L0: the file is the only place the ordering is
written down.

**It carries the layer's own name because it is the layer's vocabulary** — the
relationship `errors` has to L0, where the vocabulary module is not called
`kernelvocab` either.

### Framework-neutral because two servers ship behind one port

`../ARCHITECTURE.md` Part III expects a framework to be used where it owns
something, and the general argument for a neutral floor follows from that. **The
argument here is stronger, and it is the part specific to this repository.**

This blueprint runs `node:http` **and** Fastify behind the same chain, on one
port. That is not a hypothetical portability concern to be traded away later —
it is a property the suite asserts on every case, by running each request
through both servers and comparing the two answers to each other rather than to
a transcript. A chain written against either framework's request type could not
do that, and a middleware that only ever sees `Request` and `Response` cannot
accidentally couple itself to one of them.

So the floor is neutral because the repository would not work otherwise, not
because neutrality is generally a virtue.

### `Reporter` lives here, not in `logger`

Interfaces belong to the consumer, and every position in the chain is a
consumer. `httpx` needs one for the access line; `idempotency` needs one to
announce a fail-closed refusal, because invariant `I9` requires the choice to be
*logged when it fires* rather than merely made. Two modules, one shape, neither
owning it — which is the definition of a floor type.

### The committed-tracking response writer is not here yet

`../MODULES.md` §5's late-error rule wants a response writer that records
whether it has been written to, so an error arriving after the response is
committed aborts the connection instead of sending a well-formed truncated
body. The floor is where that belongs.

It is absent because the premise is absent. `Response.body` is a `string`, so
**nothing behind this chain streams**: a response is complete before any
position sees it, there is no committed state to track, and the rule is
satisfied vacuously.

Vacuously is a real answer only while the premise holds, so it is written down
rather than assumed. **When `httpx` grows a streaming response, the writer
belongs in this file** — and the trap it exists to avoid comes with it: a naive
wrapper that forgets the platform's optional interfaces silently disables
streaming on every endpoint the chain touches, invisibly to any test asserting
only status and body.

## Gotchas

- **No behaviour, deliberately.** `json` and `text` are two-line constructors
  and are the most this file should ever do. The moment a floor grows logic, the
  modules above it start disagreeing about which of them owns the behaviour.
- **`Exchange` is mutable in exactly three places**, and each is set *after* the
  position that earns it: provenance at 1, actor at 6, tenant at 8. That is what
  makes the chain order a contract rather than a preference.
- **`remaining()` is reachable and nothing spends it.** `../RESILIENCE.md` §4
  asks for the budget to exist before `deadline` does, so position 5 becomes
  arithmetic over a value already there. `../MODULES.md` §5 has since said more
  about how a budget should be carried, and this repository has not answered it
  yet — see `notes/patterns/httpx.md`.
- **A type here is a collection-visible decision.** `httpx`'s name and chain
  order do not vary between blueprints, and neither does this module's:
  `../ARCHITECTURE.md` §L4 names it.
- **It was briefly called `exchange`**, after the central type. The name was
  wrong for a reason a header cannot fix: this repository ships `events`, and to
  most readers an exchange is an AMQP exchange — a broker concept apparently
  sitting at the HTTP edge is a worse first guess than no guess at all, and the
  reader forms it before reaching any explanation.

## Used in

- `src/shared/edge/index.ts`

Imported by `httpx` and by every position in its chain. Today that is
`idempotency`; `ratelimit`, `conditional` and `deadline` join it.

## Related

[[httpx]] — assembles the chain these types describe. [[idempotency]] — the
first position to import the floor rather than a peer. [[provenance]] — carried
on the `Exchange`, and the reason positions 6 and 8 mutate it. [[clock]] — the
`Millis` the budget is measured in. [[logger]] — what a `Reporter` is usually
satisfied by, without either module knowing about the other.
