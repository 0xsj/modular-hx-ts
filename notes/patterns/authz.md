---
module: authz
layer: L3
---

# Authz

## What

```
Subject     { actor, roles, scopes?, tenant }   an explicit parameter, always
Action      "user:list"                         a named permission
Resource    { type, id?, ownerId? }
Authorizer  allow(subject, action, resource?) -> Decision
            reach(subject, action)            -> unrestricted | own | denied
```

## Why

### The Subject is explicit where provenance is ambient

This repository carries `provenance` in an `AsyncLocalStorage` and deliberately
does **not** carry the `Subject` that way. The difference is not taste, and it
is the reason the module exists.

| | provenance | Subject |
| --- | --- | --- |
| what it is | metadata | **a decision input** |
| anything branches on it | no | **yes** |
| cost of it being missing | a correlation id is lost | **everything is granted** |
| a forgotten one looks like | a gap in a trace | **a passed check** |

That last row is the whole argument. If the subject were ambient, a use case
that forgot to check would have the same signature, the same call site, and no
diff against one that checked. `../ARCHITECTURE.md` Part II §3 rule 6:

> The Subject is an explicit parameter on every use case. Never read from a
> context, never from a request, never from a global.

**If a use case can be called without one, it will be.**

TypeScript can state this in the type system — `Command<In, Out>` puts the
subject in the signature, so omitting it fails to compile. That was worth
checking rather than assuming; rule `M4` covers the ways a type can be defeated.

### Deny by default, structurally

An action with no matching grant is denied. An authorizer that was never wired
is **`denyAll`, not `allowAll`** — so a forgotten wire shows up as 403s in the
first test rather than as an open admin endpoint.

This is the reference case for invariant `I9`: security controls fail closed,
availability controls fail open, and the choice is visible in code. `health`
fails open for the same reason in the other direction — an unknown health state
serves traffic; an unknown permission does not grant it.

An **unknown action is denied, not an error.** A typo in a call site must not be
distinguishable from a permission the caller genuinely lacks, or the error
message becomes an enumeration oracle.

### Policy is data, owned by the root

Contexts **name** permissions; the composition root holds the one mapping from
role to grants. `authz` does not know what a user is — it knows subjects,
actions and resources, which is what keeps it L3 and domain-free while
`identity` is a context.

It is **validated at boot**, against the set of actions contexts declare. A
grant naming an action nobody implements is a typo that would otherwise present
as a permission that simply never applies — the hardest kind to notice, because
the endpoint denies and everyone assumes that is the intent.

### `own` versus `any` is scope, not two actions

*Your own audit records* and *every audit record* are the same action at two
reaches. Splitting them into `audit:read` and `audit:read_all` is how the two
drift apart: one gains a condition, the other does not, and nobody notices until
an auditor asks.

The tri-state — `unrestricted` · `own` · `denied` — is what every list endpoint
needs **before** it builds a query, so `reach` lives here rather than being
written slightly differently in each context.

An **unowned resource is unreachable by an `own` grant**. Absent is not "mine".

### Scopes only ever subtract

When a subject carries scopes — an API key rather than a person — the effective
permission is the **intersection** of its scopes and its owner's grants.
Evaluated as *grant first, then narrow*, never as a union.

**A leaked key must not be able to exceed the human it belongs to.** A scope
naming an action the owner lacks grants nothing; a scope list that is *empty*
permits nothing, which is not the same as *absent*, which means a person.

That last distinction is the inversion worth guarding: treating "no scopes
listed" as "no restriction" is how a locked-down key becomes a superuser.

### The fence runs before grants

`tenant` lands next, and its fence **beats every grant, including an
administrator's** — a cross-tenant resource is invisible, not forbidden.

Not built here. What is built is the **order**: `before` runs ahead of any grant
lookup and a `false` denies outright, so nothing in this module assumes grants
are the first thing examined. The fence arrives as a wiring change rather than a
restructuring.

`refusal` returns `Forbidden` rather than `NotFound` on purpose: hiding
existence is the fence's job and a different question from permission.
Conflating them here would make the two indistinguishable in a log.

## Example

```ts
// The root owns the policy and validates it at boot.
const policy = unwrap(compilePolicy(POLICY, declaredActions));
const authz = makeAuthorizer(policy);

// A command's signature carries the subject. This does not compile without it.
export const deleteUser: Command<{ id: string }, void> = async (subject, input) => {
  const decision = authz.allow(subject, 'user:delete', {
    type: 'user',
    id: input.id,
  });
  if (!decision.allowed) throw refusal('user:delete', decision);
  ...
};

// A list endpoint asks for its reach before building the query.
switch (authz.reach(subject, 'audit:read')) {
  case 'unrestricted': return repo.all(subject.tenant);
  case 'own':          return repo.ownedBy(subjectId(subject));
  case 'denied':       throw refusal('audit:read', { allowed: false, reason: 'no_grant' });
}
```

## Gotchas

- **`denyAll` is the default, not a placeholder.** It is exported so a test can
  be explicit and so nothing invents an `allowAll` to stand in.
- **An empty `scopes` array is not the same as `undefined`.** Empty is a key
  that may do nothing; absent is a person whose grants apply unchanged.
- **A denial does not say which grant was missing.** Coarse on purpose — the
  caller can do nothing with the detail, and the detail is an oracle.
- **`subjectId` is the actor's id, not `kind:id`.** A resource's `ownerId` is a
  user id, so comparing against `user:01a0…` would never match — and would fail
  *closed*, which is why it would have been found late.
- **The widest scope wins across roles and within a role.** Two rows saying
  different things is an authoring mistake, and silently taking the narrower one
  would deny requests the author believed were allowed.
- **`M4` covers commands only.** A query that forgets its subject leaks; a
  command that forgets it *acts*. Queries get their protection from `tenant`'s
  fence when it lands, and `Query<In, Out>` exists for the reads that need
  narrowing now.

## Used in

- `src/shared/authz/index.ts`

This list grows to every context's `app/command/` and `app/query/`, and to
`httpx`, which turns a `Decision` into a status.

## Related

[[provenance]] — the ambient one, and the asymmetry this note is built on.
[[classification]] — the other L3 vocabulary, and the same trick of stating a
rule in a type so the AST rule has little left to catch. [[errors]] —
`Forbidden`, and why it is not `NotFound`. [[health]] — the fail-open side of
invariant `I9`, for contrast.
