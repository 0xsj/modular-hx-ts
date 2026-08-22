# ADR 0008 — A transaction travels in the signature, not on the context

**Status:** Accepted · **Date:** 2026-08-22

## Context

`../MODULES.md` §3 requires `withinTx` and says nothing about how the
transaction reaches the repository that must use it. Two shapes exist across the
collection and **both are correct**:

1. **On the ambient context.** `WithinTx(ctx, fn)` puts the transaction in the
   request context; a repository pulls it out and uses it if present, falling
   back to the pool. Call sites stay short and no signature mentions a
   transaction.
2. **In the callback.** `withinTx(fn)` hands the transaction to `fn` as a `DB`;
   the caller passes it to whatever must be inside. It appears in the signature
   of everything that participates.

Observable behaviour is identical — the same writes commit and roll back
together either way — so under ADR 0003 this is legitimate divergence rather
than one repo being wrong. That is exactly why it needs writing down: the fork
is real, it is invisible in the conformance suite, and left in code alone the
next person re-derives it or assumes the sibling's shape.

**Ambient was genuinely available here**, which is what makes this a decision
rather than an omission. This repository already runs `AsyncLocalStorage` for
`provenance`, the plumbing is written and tested, and shape 1 would have been
the smaller diff.

## Decision

**The callback receives the transaction as a `DB`.**

```ts
await db.withinTx(async (tx) => {
  await makeUserRepository(tx).create(user);
  await makeAuditRepository(tx).record(event);
});
```

The `DB` handed to `fn` **is** the transaction. Because a pool and a transaction
satisfy `DB` identically, a repository constructed with it writes inside the
transaction without knowing one exists — so the transparency shape 1 buys is
already paid for by `DB`, and ambient carriage would be buying it twice.

`Transactor` remains **consumer-declared in `app/`**; this module does not
export it. It is declared inside `postgres` for documentation and for a
compile-time assertion that the pool satisfies it, which is the one thing a
consumer-declared interface cannot check for itself.

## Alternatives considered

- **Ambient carriage in `AsyncLocalStorage`, as `provenance` uses.** The real
  alternative, and rejected on a specific asymmetry that
  `../PROVENANCE.md` §3 already draws for `authz`. Nothing branches on
  provenance, so a repository that misses it degrades observability and grants
  nothing. A repository that **misses an ambient transaction writes outside it
  and reports success** — the write lands, the caller sees no error, and the
  atomicity the use case asked for silently did not happen. That is the same
  failure class as a forgotten authorization check looking exactly like a passed
  one, and §3's answer there is that ambient is the wrong mechanism. Passing it
  in the signature makes the mistake unrepresentable rather than merely
  unlikely.
- **A second set of transactional methods** — `create` and `createTx`.
  Rejected: this is precisely what `DB`'s dual satisfaction exists to avoid, and
  it doubles every repository for a distinction the repository should not be
  making.
- **Hand repositories the pool and let them open their own transactions.**
  Rejected: atomicity spanning two repositories then becomes impossible to
  express, which is the only case that needed a transaction in the first place.
- **Both — explicit parameter with an ambient fallback.** Rejected as the worst
  of the three: the fallback is silent, so the failure mode of shape 1 is
  preserved exactly while the signature suggests it is not.

## Consequences

- **Use cases thread `tx` to every repository that participates.** That is more
  typing than shape 1 and it is the point: the set of writes inside the
  transaction is readable from the call site without knowing what any repository
  does internally.
- **Nested `withinTx` on the pool is not joined automatically.** A use case
  already inside a transaction that calls `pool.withinTx` again gets a *second,
  independent* transaction on a second connection — which can deadlock against
  the first. Shape 1 detects this for free by finding the ambient transaction.
  Here it is a code-review concern, and the mitigation is that the `tx` is right
  there in the signature to pass down. **Not currently guarded**; if it bites,
  the fix is a `AsyncLocalStorage` flag used *only* to refuse the nesting, not
  to carry the transaction — which keeps this decision intact.
- A repository is testable with a plain object satisfying `DB`, with no ambient
  setup and no context to install.
- This repository will read differently from siblings that chose shape 1. That
  is the intended kind of difference: structure diverges, behaviour does not.

## Verification

`tests/integration/postgres/db.test.ts` is the direct test, and it is §3's own:
one repository function whose signature names `DB`, run against **a pool, a
transaction, and `testx`'s per-schema pool**, with no second version for any of
them. It includes the rollback case — the repository does not opt in to
atomicity and cannot opt out of it either.

`src/shared/postgres/pool.ts` carries `PoolSatisfiesTransactor`, a compile-time
assertion that the pool still matches the `Transactor` shape an application
layer will declare. If `withinTx` drifts, **the build breaks in `postgres`**
rather than in a consumer that declared its copy against the old shape. Verified
by drifting the signature deliberately: `Type 'false' does not satisfy the
constraint 'true'`, reported in `pool.ts`.

The nesting consequence above is **not verified**, because it is not guarded.

## Enforced by

Nothing structural, and that is correct rather than a gap: `../ENFORCEMENT.md`
has no rule id for how a transaction is carried, and both shapes are permitted
by ADR 0003, so a rule here would be enforcing a preference.

`S1` keeps `postgres` at L2 and below the repositories that use it, which is
what makes the consumer-declared `Transactor` meaningful in the first place.
