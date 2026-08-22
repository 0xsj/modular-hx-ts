# ADR 0007 — Kysely is the query layer, above `DB`

**Status:** Accepted · **Date:** 2026-08-22

## Context

`../MODULES.md` §3 settles this deliberately and leaves the answer open:

> **Choose per repo, and record it.** pgx, sqlx, Kysely, Drizzle, SQLAlchemy
> Core, raw SQL — the query layer is *structure*, and ADR 0003 says structure
> diverges. Forcing one answer into three ecosystems fights all three.

It also says where the choice is allowed to matter: **`DB`** — `query`,
`queryRow`, `exec` — is what a repository depends on, and it names SQL and
parameters. §3 gives the test in one line: *if swapping the query layer would
change a repository's signature, the interface is in the wrong place.*

So the decision is smaller than it looks. Whatever is chosen sits **above**
`DB`, produces SQL and parameters, and hands them down.

## Decision

**Kysely**, used by repositories to build SQL, compiled and handed to `DB`.

Three consequences of that placement, and they are the substance:

1. **`postgres` depends on `pg` and nothing else.** The query layer is not a
   dependency of the substrate — the substrate executes SQL. `src/shared/postgres`
   imports `pg` and would not change if this ADR were superseded tomorrow.
2. **Kysely arrives with the first repository**, not now, per ADR 0005. There is
   nothing to query yet, and a dependency added ahead of its consumer is one
   nobody can justify by pointing at a caller.
3. **Kysely is deliberately *not* in the `S10` vendor table.** `S10` confines an
   SDK to one module because a spreading SDK becomes the interface. A query
   builder used by every repository is spread **by design**, and the thing that
   stops it becoming the interface is `DB` sitting underneath it, not an import
   rule. Adding it to the table would be enforcing a confinement that is not
   true and would have to be exempted at the first repository.

Why Kysely over the alternatives, in the order that mattered:

- **It takes an existing pool rather than owning the connection.** This is the
  deciding property. §3 requires the DSN to be a parameter and the migrator to
  take a pool; a query layer that manages its own connections would fight both,
  and `testx`'s schema-per-test would have to be re-litigated inside it.
- **It emits plain SQL.** What is logged is what ran, and `NULLS LAST` — the
  first case in the storage-behaviour suite — can be written explicitly rather
  than inferred from a builder's defaults.
- **No codegen step and no runtime schema.** Types come from a declared
  interface, so nothing has to be regenerated for the build to be correct.

## Alternatives considered

- **Raw SQL with `pg` alone.** Genuinely viable, and it was the incumbent under
  ADR 0005 — no second dependency at all. Rejected on the specific failure it
  invites: hand-numbered `$1, $2, $3` parameters, renumbered by hand every time
  a clause is added, across every repository in every context. That is a runtime
  bug a type system should be catching, and it is the one kind of defect that
  survives review because the SQL still looks right.
- **Drizzle.** Close, and better known. Rejected because its schema-first model
  wants to own migrations, and migrations here are forward-only, checksummed and
  applied under an advisory lock by `postgres` — the overlap would be a fight
  rather than a feature.
- **Prisma.** Rejected on placement, not quality: it owns the connection, the
  schema and the migrations, which makes it an alternative to `postgres` rather
  than a layer above `DB`. Choosing it would mean deleting this module.
- **`pg-promise`.** Rejected: it is a driver wrapper rather than a typed query
  layer, so it solves neither the parameter-numbering problem nor the typing
  one, and it does own the pool.

## Consequences

- **Two runtime dependencies where there were none.** `pg` has landed; `kysely`
  will. `dependencies` stayed empty for 26 modules and this is where that ends,
  which is exactly the visibility ADR 0005 was written to produce.
- A repository can drop to raw SQL through `DB` at any point, because `DB` is
  what it depends on. Kysely is a convenience above the port, not the port.
- **This choice is unvalidated until the first repository exists.** No
  repository has been written, so nothing here has been exercised against real
  queries. If it turns out to fight keyset pagination or the `NULLS` clauses,
  that is a supersession and not an edit (`D3`).
- §3 nominates **this repository** for the two-adapters-under-one-repository-port
  experiment. That experiment is now cheap in the right way: the second adapter
  is raw SQL through the same `DB`, and both run the same repository suite.

## Verification

The claim that the query layer is swappable is verified today, before any query
layer exists, by `tests/integration/postgres/db.test.ts` — one repository
function whose signature names `DB`, run against **a pool, a transaction, and
`testx`'s per-schema pool**, with no second version for any of them. That is
§3's own test, and it fails if `DB` ever grows a query-layer type.

`src/shared/postgres/storage.contract.ts` verifies the four behaviours that make
divergence safe, and takes its subject as a parameter so a second adapter runs
it unchanged.

**Kysely itself is not yet verified by anything**, because it is not yet
installed. It becomes verified when the first repository runs the storage suite
and its own contract suite through it.

## Enforced by

`S10` — vendor confinement, which keeps `pg` inside `src/shared/postgres`. That
rule was **inert for installed packages** until `pg` landed: its matcher missed
pnpm's `node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/…` layout, so
every entry in the table passed vacuously. The fixture caught it on the same
change that installed the first vendor package, and
`tests/rules/arch.test.ts` now asserts all three layouts directly, because a
fixture tree has no `node_modules` and cannot cover the resolved form.

`S1` — `postgres` is L2 and may import only L1 and below, which is what keeps
the substrate underneath the repositories rather than beside them.
