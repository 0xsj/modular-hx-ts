---
module: tenant
layer: L3
---

# Tenant

## What

A tenant id on provenance, a registry with two adapters, a resolver, a
fail-closed accessor, and a fence that runs before authorization.

## Why

### Single mode must be byte-identical to no tenancy

**The headline property, not a footnote.** With `TENANCY=single` there is one
seeded tenant, **zero lookups**, and behaviour indistinguishable from a build
that never heard of tenants. Conformance case 21.

That is what makes carrying this from day one *free* — and it is exactly why
adding tenancy later is not. Retrofitting touches every query in every
repository, every event envelope, every audit row and every cache key **at
once**, which is a change nobody can review and nobody can stage.

Two decisions keep it byte-identical:

- **The default tenant is a real tenant**, seeded by a migration, not a `null`
  threaded through every call site. Single mode runs the multi-tenant code path
  with a lookup that cannot fail.
- **Single mode does not consult the registry at all.** Not a hit that happens
  to return one row — no call. The header is ignored rather than validated,
  because validating it would be a behaviour a no-tenancy build does not have.

The test is a counting registry asserting **zero** calls.

### Resolution happens before authentication

Header or host subdomain, checked against the registry: unknown **404**,
suspended **403**. Conformance case 22.

The ordering is the whole point. Resolving *after* auth means a credential
issued by tenant A is evaluated in tenant B's context before anyone notices —
the session lookup, the role expansion and the audit row all run against the
wrong tenant, and every one of them **succeeds**.

The header wins over the host, because a deploy behind a proxy that rewrites
`Host` would otherwise be unable to address a tenant at all. Only a **single**
subdomain label resolves: `a.b.example.com` is not tenant `a.b`, and an
attacker-chosen `Host` must resolve nowhere.

### The fence is not a grant

**It beats every grant, including an administrator's** — conformance case 24.

`authz` left `AuthorizerOptions.before` open for this, so the check runs *ahead
of* any grant lookup rather than being the most powerful grant.

That distinction is the module. A fence that were merely the strongest grant is
a fence somebody can **out-grant**: one policy edit, one new role, one `*` in
the wrong place, and the boundary is gone with no code change and no review that
looked like a security change. Running first means **no policy can express
crossing it**.

The test proves it by running the same request through an authorizer with and
without the fence: the unfenced one allows it, because the grant genuinely is
unrestricted.

### Invisible, not forbidden

A cross-tenant resource is **404, never 403** — conformance case 23.

The one people get wrong, because 403 feels more honest. It is honest *to the
attacker*: a 403 confirms the resource exists, which turns any id into an oracle
for what other tenants hold.

`invisible()` exists so no call site has to decide, and `refusal()` in `authz`
deliberately returns `Forbidden` — hiding existence is this module's job, and
conflating the two would make an ordinary denial indistinguishable from a fence
hit in a log.

### Scoping is the repository's job, and it fails closed

Every query filters by the request's tenant, and a repository that finds no
tenant on the context returns `Internal` rather than querying without the
filter. That is `requireTenant`, and rule `M3`.

Why it is worth a rule: **the violation does not error, it returns other
people's data.** Nothing goes red. The endpoint is fast, the tests pass, and the
bug is found by a customer.

### What carries the tenant, and what does not

Because it is on provenance, it already reaches **log lines, event envelopes and
audit rows** for free. Three things do not come free:

| | now | why |
| --- | --- | --- |
| **lock keys** | ✅ namespaced | `lock` already takes a namespace; a singleton job is fleet-wide *per deployment*, and a tenant-scoped lock is a caller passing a tenant-qualified name |
| **cache keys** | ⏳ deferred | `cache` is not built. **Trigger:** the module lands — one tenant's cached user answering another's request is the failure, and the namespace belongs in `cache`'s key builder rather than in every caller |
| **idempotency scopes** | ⏳ deferred | `idempotency` is L4 and not built. **Trigger:** the module lands — a key is scoped per tenant, or tenant A's replayed request returns tenant B's stored response |

Both deferrals are recorded in `docs/TREE.md` → Later with those triggers.

### `app.tenant_id`, set before anything reads it

`withinTx` sets it from the ambient provenance. **Nothing reads it yet.**

It is there so PostgreSQL row-level security can be added later **without a
second pass over every adapter** — an RLS policy reads
`current_setting('app.tenant_id')`, and retrofitting the `SET` means touching
every transaction in the codebase on the day the policy is written.

`SET LOCAL`, so it is transaction-scoped and cannot leak onto a pooled
connection; there is a test for that. Absent when there is no ambient tenant — a
migration or a boot job is not tenant work, and an empty string would look like
a tenant named `""`.

## Example

```ts
// Before authentication, at the edge.
const resolved = await resolver.resolve({ header: req.headers['x-tenant-id'] });
if (isErr(resolved)) return respond(resolved.error);   // 404 or 403

const provenance = origins.forRequest(headers).withTenant(resolved.value.id);

// The fence is wiring, not a call site.
const authz = makeAuthorizer(policy, { before: fence });

// A repository, failing closed.
const tenant = unwrap(requireTenant(provenance.tenant));
return db.query('select id from widgets where tenant = $1', [tenant]);
```

## Gotchas

- **An unrecognised status is suspended, not active.** A row somebody set to a
  value this build does not know about must not be usable; failing open there
  would make an unknown value a bypass.
- **The fence does not apply to a resource with no tenant.** *May this subject
  list users at all?* is not a fence question, and denying it would break every
  list endpoint before `reach` could narrow it.
- **A slug is a DNS label**, because it reaches a hostname — lowercase,
  no leading or trailing hyphen, 63 characters.
- **A tenant id must satisfy the provenance id shape.** `PROVENANCE.md` §7 makes
  it **L3's obligation to mint ids that satisfy a rule owned by L1**, because
  the id reaches hashed bytes.
- **`M3` exempts a file with a justified `nolint:tenant` marker.** A `create
  table` cannot be tenant-scoped, and a marker naming why is a reviewable line
  rather than a silent omission.
- **Both adapters run the cross-tenant cases.** *The filter is in the SQL* and
  *the filter is in the memory predicate* are two implementations of one
  promise.

## Used in

- `src/shared/tenant/index.ts`
- `src/shared/postgres/pool.ts`

This list grows to every repository, to `httpx`'s resolution middleware, and to
`cache` and `idempotency` when their namespacing lands.

## Related

[[authz]] — the `before` hook this fills, and why the fence is not a grant.
[[provenance]] — where the tenant lives, nullable at L1 with the refusal owned
here. [[postgres]] — `app.tenant_id`, set before anything reads it. [[lock]] —
already namespaced. [[errors]] — `NotFound` versus `Forbidden`, and why the
choice is a security decision rather than an ergonomic one.
