---
module: postgres
layer: L2
---

# Postgres

## What

The pool, the transaction, the SQLSTATE mapping and the migrator. Plus the
storage-behaviour suite, which is not a contract suite and is described below.

```
DB          query · queryRow · exec          <- what a REPOSITORY depends on
Postgres    DB + withinTx + ping + close     <- the concrete thing
Config      a struct; the DSN is a parameter
migrate(pool, set)                           <- a tool the root runs
```

## Why

### `postgres` is the L2 exception, and the only one

Every other module at L2 is a port with a memory adapter, a real adapter and one
contract suite both pass. This has none of that, deliberately. It is what the
real implementations are *built on*, and its memory counterpart does not exist
because **a memory repository does not use it** — `STORAGE=memory` never reaches
this module. Rule `M1` applies to the repositories above it, never here.

There is **no fake pool**, and there should not be one.

### "Make it swappable" has a trap in it

`postgres` itself is **not an interface**. Generic-over-dialects costs a great
deal and buys nothing here, and the memory-versus-real swap already works
without it. An interface that a Postgres pool and something-else both satisfy is
an abstraction over an abstraction.

Swappability lives in two interfaces that do different jobs, and confusing them
is how repositories end up untestable.

**`DB` — what a repository depends on.** Three methods, and **both a pool and a
transaction satisfy it**. That dual satisfaction is the whole point: it makes
`withinTx` transparent, so a repository method works identically inside a
transaction and outside one, and there is never a second set of methods for the
transactional case.

It names **SQL and parameters, never a query builder**. That is where query-layer
swappability actually lives, and it only works if the type does not mention the
query layer — a repository naming `Kysely` in its signature would have to change
to swap it, which is the test §3 gives for the interface being in the wrong
place. Declared here rather than per-consumer: it is close enough to universal to
be treated like `io.Writer`, and a per-context copy of three signatures is
ceremony rather than inversion.

**`Transactor` — what a use case depends on.** `withinTx`, **declared in `app/`,
implemented here**. Not negotiable, and the reason this module does *not* export
that interface: an application layer that imported `postgres` to say "these
writes are atomic" would have inverted nothing. The use case knows it needs
atomicity; it must not know what provides it.

`Config`, the pool and `migrate` are none of the above — a struct, a concrete
thing, and a tool the composition root runs. Nothing swaps them.

### How the transaction travels — a deliberate fork

Two shapes exist across the collection and **both are correct**, because the
observable behaviour is identical:

| | shape | cost |
| --- | --- | --- |
| **Ambient** | `withinTx(ctx, fn)` puts the transaction on the context; repositories find it | a repository that *misses* it writes outside the transaction and reports success |
| **Explicit** *(here)* | `withinTx(fn)` hands it to the callback as a `DB` | more threading; nested `withinTx` on the pool is not joined for you |

This repo chose **explicit**, and it was a choice rather than an omission:
`AsyncLocalStorage` is already running here for `provenance`, so ambient was the
smaller diff.

The reason is the asymmetry `../PROVENANCE.md` §3 already draws for `authz`.
Nothing branches on provenance, so a missing one degrades observability and
grants nothing. A repository that misses an **ambient transaction** writes
outside it and **reports success** — the write lands, no error surfaces, and the
atomicity the use case asked for silently did not happen. Same failure class as
a forgotten authorization check looking exactly like a passed one. Passing it in
the signature makes the mistake unrepresentable rather than merely unlikely.

Full reasoning and the rejected alternatives: ADR 0008.

### `Transactor` is declared here and must not be imported from here

`../MODULES.md` §3 is not negotiable: `Transactor` is **consumer-declared in
`app/`**. A use case that imports `postgres` in order to say *"these writes are
atomic"* has inverted nothing.

So the shape is declared in `pool.ts` and **deliberately not re-exported from
`index.ts`** — it exists for one thing a consumer-declared interface cannot do
for itself:

```ts
export type PoolSatisfiesTransactor = Assert<
  Postgres extends Transactor ? true : false
>;
```

Consumer-declared interfaces have one quiet failure mode: every consumer
declares its copy against the shape as it was, and a drift in `withinTx` breaks
each of them separately, later, far from the change that caused it. This line
moves the break **into `postgres`** — the module that drifted stops compiling.
Verified by drifting the signature on purpose; the error lands in `pool.ts`.

### The DSN is a parameter, and that is structural

A test appends `search_path=<schema>` to get a schema of its own. If this module
read the DSN from the environment or a global, every test would share one
schema, none could run in parallel, and the fix would be a rewrite of the
constructor rather than an addition. Same for the migrator taking a pool: one
that found its own connection could not be pointed anywhere.

Both had to be right in the first line written, which is why they are.

### All three guardrails, on by default

PostgreSQL ships `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` **unlimited**. That is how a single bad
query exhausts a pool: every connection ends up behind it and the process stops
serving anything.

**Migrations are exempt from the statement budget and not from the lock one.** A
migration legitimately takes longer than a request. A migration that cannot get
its lock should still fail fast rather than hold the deploy open while it blocks
live traffic. `SET LOCAL` is transaction-scoped, so nothing leaks back onto the
pooled connection.

### Forward-only, checksummed, namespaced, serialised

No down migrations. The rollback story is a **new forward migration**, and a
breaking change is made by expand/contract — add, deploy, backfill, contract in
a later release. A down migration is a plan written before the failure, tested
never, and run in the one situation where being wrong is unrecoverable.

The checksum is the reason to record anything at all: an applied migration that
has been edited means the database and the repository disagree about what ran,
and every later assumption is unfounded.

One transaction, holding a transaction-scoped advisory lock, so N instances
deploying together **serialise rather than race** — the second waits, then finds
nothing to do.

### The storage-behaviour suite is not the repository contract suite

A repository suite asserts *this context's* reads and writes. This one asserts
*the substrate behaves the same regardless of how the SQL was produced*, so it
runs even with one adapter — the properties are worth pinning when nothing is
being compared.

| # | Property | Why |
| :-: | --- | --- |
| 1 | NULL ordering in `ORDER BY` | Postgres defaults `NULLS LAST` for `ASC` and `NULLS FIRST` for `DESC`. A keyset cursor over a nullable column breaks **only at a page boundary**, silently |
| 2 | SQLSTATE → `Kind` | A unique violation is `Conflict` everywhere, or the same operation is 409 in one blueprint and 500 in another — conformance §4.1 |
| 3 | Isolation default, and implicit transactions | Two adapters differing here behave differently under concurrency and identically in every single-threaded test |
| 4 | Timestamp precision and zone on round-trip | Drivers differ on microseconds and on whether a zone survives |

Written **before the first repository exists**, which is the only cheap moment.

## Example

```ts
const db = connect({ dsn: config.databaseUrl, applicationName: 'modular-hx-ts' });

await migrate(db, [...identity.migrations, ...audit.migrations]);

// A repository names DB and nothing else.
const users = makeUserRepository(db);

// The same repository, inside a transaction, unchanged.
await db.withinTx(async (tx) => {
  await makeUserRepository(tx).create(user);
  await makeAuditRepository(tx).record(event);
});
```

## Gotchas

- **Guardrails ride on the DSN as libpq startup options, not as `SET` on a
  connect handler.** The handler version was written first and `pg` rejected it
  out loud: issuing a query from the `connect` event races the borrower's own
  query, which warns today and **breaks in `pg@9`**. It had a quieter flaw too —
  a connection handed out before its `SET` landed would run one statement with
  no timeout, and that statement is the one most likely to be the runaway.
- **Options are merged, never assigned.** `testx` puts `search_path` in the same
  parameter. Overwriting it would put every test on the default schema while
  appearing to give it one of its own, and it would present as flakiness.
- **A dying connection emits twice, and the first error is the one that
  matters.** `idle_in_transaction_session_timeout` is FATAL: the client emits
  `25P03` carrying the SQLSTATE, then a code-less "Connection terminated
  unexpectedly". Keeping the latest overwrites the cause with its own
  consequence and the caller gets `Internal` for a plain timeout.
- **A client that dies mid-transaction emits `error` on itself, not on the
  pool.** With no listener that is an unhandled exception, and it takes the
  process down. The pool's own handler covers idle clients and does not cover
  this one — which the guardrail test found, because the guardrail that protects
  the database is exactly what triggers it.
- **`queryRow` returns `undefined`, not a `NotFound`.** Whether an absent row is
  a 404, an empty option or a reason to insert is the caller's decision, and a
  substrate making it would be making a domain choice one layer too low.
- **Unrecognised SQLSTATEs are `Internal` on purpose.** A code nobody has
  thought about is a bug in the query, not a condition a caller can act on, and
  guessing something friendlier turns a defect into a 4xx nobody investigates.
- **`40001` and `40P01` are `Unavailable`, not `Conflict`.** `isRetryable` is
  true for exactly `Unavailable` and `Timeout`, so mapping a serialization
  failure or a deadlock to `Conflict` would tell `retry` to stop — on the two
  failures that most want retrying.
- **The whole migration run is one transaction.** PostgreSQL's DDL is
  transactional, so a set that fails part-way applies none of itself. The
  exception nobody has needed yet is `CREATE INDEX CONCURRENTLY`, which cannot
  run in a transaction block; when it is needed, it is a second code path and
  not a loosening of this one.

## Used in

- `src/shared/postgres/index.ts`
- `tests/testx/postgres.ts`

This list grows to every repository, and to `events`, `jobs` and `lock`, each of
which is a Postgres adapter behind its own port.

## Related

[[errors]] — SQLSTATE becomes a `Kind`, which is what makes a storage failure as
queryable as a log line. [[digest]] — migration checksums are the same
`sha256:` form as every other content identity here. [[clock]] — the guardrails
are `Millis`, so a budget reads the same as every other duration. [[health]] —
`ping` is the readiness check a `critical` dependency registers. [[provenance]] —
whose ambient carriage is the shape ADR 0008 deliberately did *not* copy for
transactions, and §3's `authz` asymmetry is why. [[result]] —
deliberately **not** used at this boundary: the driver throws, and a substrate
that converted every failure into a `Result` would make `withinTx`'s rollback
path depend on the caller remembering to check.
