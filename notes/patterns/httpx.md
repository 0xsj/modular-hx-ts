---
module: httpx
layer: L4
---

# HTTP edge

## What

The server port, safe timeouts, the middleware chain written once, and RFC 9457
problem mapping. **Not** routing tables, not handlers, not any context.

```
provenance · access log · problem mapper · recover · [deadline] ·
authn · [ratelimit] · tenant · [idempotency] · handler
```

Bracketed positions are **named and empty**. Two servers — `node:http` and
Fastify — run the same chain behind one port.

## Why

### The order is specified, not chosen here

`../MODULES.md` §5 fixes it, and that is the point of fixing it: eight
repositories each inventing a plausible order produces eight different answers
to *does a 429 carry a request id*, and none of them surfaces until something
downstream depends on it. Two positions are counterintuitive, and those are the
two worth writing down twice.

### The chain vocabulary moved out, into the floor

`Request`, `Response`, `Exchange`, `Handler`, `Middleware` and `Reporter` now
live in `edge`, the **floor of L4** — `../ARCHITECTURE.md` §L4. `httpx`
assembles the chain; the other L4 modules are positions in it, and all of them
need the types. See [[edge]].

What stayed: the order, the servers, the timeouts, and the problem mapping.

### A cancellation is recorded, never rendered

Collection decision 0010 added `canceled`, and its 499 is **for the log, not the
wire**. When the caller has disconnected there is nobody to send a status to, so
position 3 skips rendering entirely: no problem body, no content type, status
499, and `err_kind` on the access line.

This is the late-error situation reached by a different route. Serialising a
document into a closed socket spends work on nobody, and — worse — it writes a
*response* into the access log where a truncated exchange belongs. The value
exists so the log can say what happened instead of recording a request that
simply stops.

### Recover sits *inside* the problem mapper

The instinct is to put it outermost, where it catches the most. But a panic
caught above the mapper has to render its own response — and then there are two
places that build an error body, which is exactly what invariant `I7` exists to
prevent. Inside, a panic becomes a typed `internal` and is rendered by the same
code that renders a returned one.

**A panic and a returned error are indistinguishable to the client.** Same
status, same content type, same generic detail, same `instance`. That is the
property being bought, and it is what the test asserts — not the arrangement.

The corollary took a failing test to find: **recover must not wrap a typed
error.** Wrapping adds context, and `detail` on a 4xx is the message verbatim,
so a deliberate `notFound('no such thing')` reached the client as
`the request could not be handled: no such thing`. Context is added where a
layer boundary is crossed and something is known; this position knows only that
something threw.

### Ratelimit sits *after* authn, and the trade is real

The instinct is the opposite — reject cheap work early, before spending a
signature verification on a caller who is about to be throttled. But conformance
case 40 requires **per-caller** limits, and a limiter that runs first has no
caller to key on. It can only key on the peer address, which is one NAT away
from being useless and one proxy away from being wrong.

So an auth check is spent on a request that is then refused. That cost is noted
rather than the order reversed, because the alternative is a limit that does not
limit what it claims to. A genuinely impossible position would be an ADR; a
merely expensive one is a paragraph.

### What the chain guarantees that no individual middleware does

Each of these is a property of the *composition*. No position delivers one on
its own, and any reordering loses at least one:

- **Every response carries a request id** — a 200, a 429 from a slot nobody has
  filled yet, and a 500 from a `TypeError` thrown three positions down. Position
  1 is outermost precisely so there is no exit that skips it.
- **Every error body is built in exactly one place.** Everything below position 3
  throws; only position 3 renders. A handler *can* return a 400 with a text body,
  but it cannot produce a *problem* body, because the only code that builds one
  runs on a throw.
- **The access log records the status that finally emerged**, not the one the
  handler intended — including one produced by a panic, because position 2 is
  outside both 3 and 4.
- **Provenance is ambient below position 1**, so a log line written by code that
  never asked for provenance still carries one.

### `httpx` is the one and only caller of adoption

`../PROVENANCE.md` §5: correlation, causation and traceparent may be adopted.
Request id, actor and tenant may not — a caller-supplied request id lets two
requests share an identity, which breaks idempotency reasoning and audit
uniqueness, and a caller-supplied actor is an authentication bypass with extra
steps.

The `InboundHeaders` type carries only the three permitted fields, so the bypass
is not something to remember. It is something that cannot be written. What the
type does not cover is the response, so there is a separate assertion that the
minted id is echoed back rather than the caller's — the observable half of the
same bypass, and the half a type cannot reach.

**A malformed value is dropped, never a request failure.** Provenance grants
nothing, so strictness is free: the worst case of rejecting a malformed
correlation id is a broken trace link; the worst case of accepting one is log
injection.

### Position 5 has a budget, and nothing spends it

`../RESILIENCE.md` §4 asks for the request's remaining budget to be reachable
from the context *before* `deadline` exists, so that module becomes arithmetic
over a value already there rather than a new thing threaded through every
handler. `Exchange.remaining()` is that value: it counts down from position 1
and floors at zero.

The three slots are declared as options rather than described in a comment for
the same reason. A slot added after three modules have each chosen their own
insertion point is the expensive retrofit.

### Two servers, one behaviour

`../ARCHITECTURE.md` Part III expects a framework to be used where it owns
something. Fastify owns routing, schema and the socket; the chain owns the
cross-cutting order. Wrapping Fastify to look like `node:http` would be the
failure, and so would re-implementing routing to avoid using it.

What must not vary: the module name, the order, the single mapping point, and
the observable behaviour. So the chain is written against framework-neutral
`Request`/`Response` types, and **every adapter case in the suite runs twice and
the two answers are compared to each other** rather than to a transcript written
by hand. A transcript can be edited to match whichever adapter drifted; the
other adapter cannot.

### Timeouts are values, and one of them had to be built

Read-header, read, write and idle are written down rather than left to defaults,
because Node's defaults have changed between majors and relying on one is
relying on a number nobody wrote down. They are **distinct from position 5's
budget**: the server's protect the process from a peer that will not finish
speaking, the budget bounds the work a handler may do once it has.

Writing the test for that turned up a real gap. `server.headersTimeout` is the
documented lever for the slowloris case, and setting it is not enough: on Node
22.21 a peer that opened a connection and stalled mid-headers was still
connected ten seconds later in every configuration measured — request line only,
partial header, complete headers with a truncated body, `requestTimeout` set
alongside it, and `connectionsCheckingInterval` lowered to 100ms. A socket-level
inactivity timer fires as documented, so `guard.ts` arms one on connect and
**releases it once the headers arrive**. The release is the whole design: armed
for the connection's life it would be a read-header timeout wearing the wrong
name, and a handler that thinks for half a second would be cut off mid-answer.

Both adapters install the same guard on the same `http.Server` underneath, and
Fastify's own `connectionTimeout` is set to 0 rather than to `read` — it is a
whole-socket inactivity timer, so leaving it on would disconnect a peer waiting
on a working handler through one server and not the other.

## Example

```ts
const handler = chain(
  {
    clock,
    origins,
    telemetry,
    reporter: logger,
    authenticate: verifyBearer,
    resolveTenant: fromSubdomain,
    // deadline, ratelimit and idempotency stay empty until those modules land.
  },
  route,
);

const server = nodeServer({ host: '0.0.0.0', port: 8080, handler });
await server.start();
```

## Gotchas

**The problem `type` is a named slug, not the `Kind` in kebab.** It was the
kind, which reads as a tidy one-to-one mapping and is a lossy one:
`CONFORMANCE.md` §3.5's catalogue is deliberately *finer* than `Kind`. A wrong
password and a missing header are both `Unauthenticated`; a client branching on
`type` — which RFC 9457 makes the stable identifier — has to tell them apart,
and the status cannot.

So an `AppError` may carry a `problem` slug and the mapper prefers it, falling
back to the kind's own name kebab-cased. `I7` is unchanged: the *rendering* is
still transport's and only transport's. What moved is that the failure gets to
name itself, which is the part a status was never able to do.

Two of them are deliberately **not** distinguished, and both are enumeration
oracles if they are: a wrong password and an unknown address are one
`invalid-credentials`, and every way a session stops working is one
`session-revoked`. The catalogue names `token-expired` separately; telling a
caller which would leak whether the token was ever real, and their next action
is identical either way.

**A 500's cause has to be logged, because the body deliberately does not carry
it.** The problem mapper renders *The request could not be completed.* for an
internal error, and that is right: the cause may name a table, a column or a
constraint, and none of that is the client's business. Which left the cause
nowhere at all — the access log carried `err_kind: internal`, the body carried a
sentence, and the `TypeError` that started it was discarded.

The comment in `recover` even claimed otherwise: *the log line still names the
`TypeError` the client never sees*. It did not. Position 3 now reports the error
with its cause, at `error` level, for **5xx only** — a 404 or a 401 is the system
working, and reporting those at `error` trains whoever reads the log to stop
reading it.

Found by asking a running process to register a user against a database missing
a table. Every unit test was green, and the only evidence of the failure
anywhere in the system was the number 500.

- **`Kind` → status lives in `problem.ts` and nowhere else.** The moment a
  second file knows what 409 is, there are two answers to what a conflict is.
- **The table is `Record<Kind, number>`, so it is total by construction** —
  adding a `Kind` without a status does not compile. This file briefly carried
  the other design: an `Invalid` error with an `unprocessable` marker in
  `details`, read here. It worked, and collection decision 0010 rejected it for
  a better reason than the one it was built on — a status a caller can attach to
  an error makes this table *advisory*, and "mapped in exactly one place" stops
  being a property and becomes a convention. Eleven kinds, eleven statuses, no
  duplicates, and a test asserts all three.
- **A 5xx `detail` is generic; a 4xx `detail` is the message.** An internal
  error's message names a table, a host or a driver, and the caller can do
  nothing with it. `instance` is what turns a support conversation into a log
  search, so it is on every problem rather than only the actionable ones.
- **`Unavailable` is generalised alongside `Internal`.** It is the kind
  `httpclient` produces from an upstream failure, and conformance case 4 is
  about that path specifically.
- **Validation returns every problem at once**, keyed by field path, in an
  `errors` map. A caller fixing one field per round trip is the same waste `env`
  refuses at boot.
- **`x-error-kind` is an internal header.** It carries the `Kind` from position 3
  up to position 2 and is stripped there. Two different kinds can produce the
  same status, and the status alone cannot tell a dashboard which.
- **The two adapters mint different request ids for the same case**, so a
  comparison between them has to lift `instance` and `x-request-id` out and
  assert their *shape*. Left in, every comparison fails vacuously — and the
  temptation is then to compare less rather than to compare properly.
- **Both adapters return a bare 500 if the chain itself throws.** That path is
  only reachable if position 3 is broken. It reports rather than renders,
  because a second error body is precisely what the single mapping point
  forbids.
- **`app.all('/*')` is the catch-all, not the routing story.** A context that
  registers its own Fastify routes still passes through the chain.

## Used in

- `src/shared/httpx/index.ts`

Every context's HTTP surface mounts behind this chain. The three empty slots are
filled by `deadline`, `ratelimit` and `idempotency` as those modules land.

## Related

[[edge]] — the floor these types moved to, and why a floor exists at all.
[[provenance]] — the adoption allowlist, and why this module is its only caller.
[[errors]] — the `Kind` vocabulary this maps, and `wrap` keeping a kind through
a layer. [[httpclient]] — the outbound mirror, and the other half of *never leak
an upstream body*. [[telemetry]] — the span position 2 opens. [[logger]] — the
access log's field set. [[clock]] — monotonic, which is what makes `took_ms`
honest. [[tenant]] — resolved at position 8, and 404 rather than 403.
[[authz]] — the `Subject` position 6 makes available, still passed explicitly.
[[lifecycle]] — `stop()` drains rather than kills.
