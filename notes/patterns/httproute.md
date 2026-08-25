---
module: httproute
layer: L4
---

# Httproute — one route registry, not seven

## What

A route is a **value**: a method, a path, the schema of its body, the schemas of
its replies, whether it needs a credential, and a handler. `router()` folds a
list of them into an `edge` handler.

It knows nothing about who the caller is. The context supplies a function that
reads one out of the `Exchange`, and the registry's only interest in the answer
is whether it is present when a route said `auth: 'required'`.

## Why

### The trigger for promotion is the second copy, not the third context

`CONTEXTS.md` §8 says the route-registration shape is `scaffold`'s job after the
third context, and the first version of this lived inside `identity` on exactly
that reading, with a note saying `S6` made it unreachable from anywhere else and
that was fine.

It was not fine, and the argument had two halves and both were wrong.

`scaffold` generates a **skeleton**. It emits a file and stops; it has no
opinion about what happens to that file afterwards. A generator that emitted
this registry into seven contexts would produce seven registries, and they would
diverge on the first bug fix — which is the failure mode a shared module exists
to prevent, arrived at by a route that felt like tooling.

And `S6` cuts the other way. *Contexts may not import each other* is not a
reason for two contexts to each keep a copy of the same mechanism; it is the
reason the mechanism belongs in the shared layer. The rule was pointing at the
answer the whole time.

The moment `audit` needed a route table, there were two copies. That is the
trigger.

### It carries no authentication, and that is what makes it shareable

`audit` requires an authenticated principal and must never see a token —
`CONTEXTS.md` §3: the composition root lends it identity's bearer auth and hands
the caller over as an authz `Subject`.

A registry that authenticated would have to know what a credential is, and there
is exactly one context allowed to know that. So `auth` is a **declaration** — the
route says whether a caller is required — and resolving one is a function the
caller passes in. `identity` passes its session resolver; `audit` passes a
function that reads what position 6 already established. Neither imports the
other, and the registry is the same code for both.

The consequence worth stating: **an anonymous caller reaching a route marked
`required` is refused by the registry**, and that refusal is a 401 the context
never wrote. A route that wants to serve both shapes declares `anonymous` and
checks for itself.

### Generic in the caller, through a factory rather than a parameter

`identity`'s caller is a session-and-user pair; `audit`'s is an authz `Subject`.
Both need the registry generic in that type, and the obvious spelling does not
work:

```ts
defineRoute<never, Caller>({ ... })   // Body inference is gone
```

TypeScript takes type arguments **all or none**. Naming the caller type at a
call site means naming the body type too, at every route, forever — and the body
type is precisely the thing the schema already knows.

`routesFor<C>()` binds the caller once and returns a function still generic in
the body:

```ts
const route = routesFor<Caller>();
route({ body: LoginBody, handle({ body }) { /* body is inferred */ } });
```

One line per context, and every route below it keeps its inference.

## Gotchas

**`meta` is a bag, and it used to be `apiKeys`.** The field started as
`apiKeys?: 'refused' | 'permitted'` because case 16 needed three endpoints to
refuse API-key callers. That is an `identity` concept, and a shared module
carrying it would have shipped one context's vocabulary to every other. It is
now `meta`, and `identity` reads its own key out of it.

**A route's `replies` map IS enforced, and this note argued it need not be.**

It said the map declares what a route *means* to answer, that several routes
answered 400 from schema validation without declaring it, and that `openapi`
would close the gap because `openapi` is what makes the omission visible. The
observation was right and the conclusion was the wrong moment — which is the
shape `ENFORCEMENT.md`'s N family now warns about: a note explaining why
something is not done is what stops it being done.

The declaration already exists, and `openapi` will publish it **as the
contract**. An undeclared status is therefore not a missing annotation, it is a
published contract that lies, in the direction clients trust. Waiting for
`openapi` means eight blueprints accumulate undeclared codes and the fix becomes
a sweep instead of a line.

`ENFORCEMENT.md` S11 now covers it, in two halves:

- `statuses.ts` computes what the **chain** can answer for a route — schema
  validation, the registry's 401, the guard's 403, position 7's 429, position
  9's 409/422/412/304 — and `tests/rules/routes.test.ts` compares that with the
  declaration. It found 29 undeclared statuses across 17 routes on its first
  run.
- The router reports a **handler** returning a status nobody declared, which is
  the half no static computation can see. It reports and never changes the
  answer: a guard that turned an undeclared 404 into a 500 would break a correct
  response to enforce its own bookkeeping.

`500` and `503` are exempt globally — every route can produce them and declaring
them everywhere would make the map unreadable.

**A wrong method is a 400, not a 405.** The router's own comment claimed 405
while the code returned 400, which is the same failure in miniature. There is no
`Kind` for *method not allowed*: decision 0010 fixed the vocabulary at eleven
and it is not among them. The distinction is still worth making and is made in
the `detail`; the status is 400, and the gap is raised for the collection rather
than widened here.

**The exempt set for position 9 is derived from this table, in the root.**
Idempotency cannot ask a route whether it is public — routing happens below
position 9 — but the composition root can ask every route before the process
starts. See `wire.ts`; the hand-written version of that list was wrong on its
first day.

## Example

```ts
const route = routesFor<Subject>();

export const routes = [
  route({
    method: 'GET',
    path: '/v1/audit',
    summary: 'Search the audit log',
    replies: { 200: z.array(RecordReply), 401: Problem, 403: Problem },
    auth: 'required',
    async handle({ exchange, caller }) { /* caller is a Subject */ },
  }),
];

export const handler = router<Subject>({ routes, caller: subjectFromExchange });
```

## Used in

- `src/contexts/identity/transport/http/routes.ts` — 17 routes, caller is a
  session-and-user pair. All on `/v1/*`: `CONFORMANCE.md` §3.5 makes the URL
  surface normative, and **a context must not appear in a path** — these were
  `/identity/*` until it did
- `src/contexts/audit/transport/http/routes.ts` — one route, caller is an authz
  `Subject` the root supplies
- `src/wire.ts` — reads `auth` off both tables to build position 9's exempt set,
  and asks each table whether it owns a path now that no prefix separates them

## Related

- [[edge]] — the L4 floor this is built on; routes fold into an `edge` handler
- [[httpx]] — assembles the chain this mounts behind
- [[idempotency]] — position 9, and the seam that made the `auth` declaration
  load-bearing outside the registry
- [[conditional]] — supplies the `Validator` a route's ETag is derived from
- [[openapi]] — will walk this table and touch no handler
