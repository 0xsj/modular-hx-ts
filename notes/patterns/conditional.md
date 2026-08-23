---
module: conditional
layer: L4
---

# Conditional requests

## What

Position 9 of the `httpx` chain, beside `idempotency`. ETags and preconditions
per RFC 9110.

```
evaluate(method, preconditions, validator) -> proceed | not-modified | precondition-failed
```

**This module ships in two halves and only one of them exists.** RFC 9110 fixes
the grammar, the comparisons and the evaluation order, so those are here and
none of it is a guess. How a handler supplies its current validator is a
one-method interface with **no implementer**, because no aggregate exists to
implement it.

## Why

### The split, and the line the collection already drew

The canonical-JSON fixtures were built before any domain existed, because RFC
8785 fixed them. The conformance cases waited, because they describe endpoints
nobody had written. `conditional` divides on the same line.

**Building the RFC half early costs it sitting unused for a while. Building it
late costs going back through code that already shipped** — and `If-Match` is
required on *every* mutating endpoint, so "every" becomes a retrofit through
handlers written without it. That is the failure the `↑` promotion in
`../MODULES.md` records, and it is why this is not premature.

### Strong and weak comparison are not interchangeable

`If-Match` requires **strong** comparison. `If-None-Match` requires **weak**.
Writing one and using it for both is the standard error in this area, and it
passes casual testing because **the two agree whenever no weak tag is
involved** — which is most of the time and never when it matters.

The disagreement is tested as a disagreement rather than as a side effect: a
table of RFC 9110 §8.8.3.2's own rows, asserting where the two functions must
give the *same* answer and where they must give *opposite* ones.

The row that looks like a bug: **a weak tag does not match itself under strong
comparison.** `W/"1"` and `W/"1"` may describe two representations that are
semantically equivalent and byte-different — that is precisely what weak means —
and `If-Match` guards a write.

### The ETag is strong, and forced rather than chosen

This is the part a future reader will undo, because it looks like arbitrary
strictness. It is not.

`If-Match` uses strong comparison, and **a weak validator never matches under
strong comparison.** So a server that emits `W/"v42"` makes conformance case 29
return 412 *permanently*: every conditional write is refused, forever, and the
case passes. **Passing for the wrong reason is worse than failing**, because
nothing ever surfaces it — the suite is green, the writes fail, and the two
facts never meet.

Strong means byte-identical representations share one validator, which means the
tag has to derive from a **canonical serialization**. Most codebases cannot have
one, which is why weak tags are so common. This one already has it: RFC 8785
canonicalization and `sha256:` identities, built for event digests and
cross-language parity. **A strong ETag is available here as a side effect of
work done for another reason entirely**, and that was not planned — it is worth
saying so, because the next repository to reach this point may not be so lucky
and should know what it is trading away.

### A tag identifies a representation, not an entity

The same resource served as JSON and as CSV must not share an ETag. A caller
holding the JSON would otherwise be told 304 for the CSV — a cache poisoned by
correctness.

So `strongTagFor(variant, value)` takes the variant, and the variant is *in* the
tag rather than beside it. Joined with U+001F, the separator this repository
already uses in `flags/cohort.ts` and `idempotency/key.ts`, for the same reason:
without one, variant `ab` over body `c` and variant `a` over body `bc` produce
the same tag.

The same requirement shapes the open interface: `Validators` receives the whole
`Exchange`, not a resource id, so an implementer can see `Accept` and decide
*which representation* it is being asked about. An interface taking only an
identifier would make the variant unrepresentable and lock the mistake into the
signature.

### The precedence order is normative, not a preference

§13.2.2: `If-Match`, `If-Unmodified-Since`, `If-None-Match`,
`If-Modified-Since`, `If-Range`. A request carrying two preconditions has
exactly one defined outcome, and a server evaluating them in a different order
gives a different answer to the same request — which a client cannot work
around, because it looks like a race.

Two details in the order that are easy to get subtly wrong, and both are tested:

- **`If-Unmodified-Since` is consulted only when `If-Match` is absent** — not
  merely when `If-Match` passed. A request with a satisfied `If-Match` and a
  violated `If-Unmodified-Since` **proceeds**.
- **`If-Modified-Since` is consulted only when `If-None-Match` is absent**, and
  only for a safe method.

### 304 on GET, 412 on a mutating method

The outcome reliably wrong in the wild, because **a browser never exercises the
412 branch**. A failed `If-None-Match` on a PUT means *create only, do not
replace*; answering 304 to it tells a client its write was skipped for caching
reasons. Both branches have a test, and the mutating one runs across PUT, POST,
PATCH and DELETE.

### Dates are ignored when malformed, and compared at second precision

§13.1.3 and §13.1.4 both say a recipient **MUST ignore** the field when it is not
a valid HTTP-date. That is a behavioural rule rather than leniency: a broken
proxy that mangles a date must not turn every conditional GET into a 412.

HTTP-date carries no sub-second component, so comparison truncates to seconds. A
`Last-Modified` of `…:00.750` against an `If-Modified-Since` of `…:00` is **not
modified** — comparing milliseconds would make every sub-second write look newer
than a header that could never express it, and every conditional GET would
transfer.

### `If-Range` takes no weak tag, ever

A partial response is **stitched into a cached representation**, so *semantically
equivalent* is not good enough: two representations a weak tag calls equal may
differ byte for byte, and splicing bytes from one into the other produces a
document that never existed. The date form is compared for exact equality rather
than with the usual `<=`, for the same reason.

Byte ranges themselves are not implemented — `evaluate` reports whether the range
is still applicable, and nothing consumes that yet. The evaluation is here
because the *precedence* is, and step 5 is part of it.

### Inside `idempotency`, not outside it

Both fill position 9, so the order between them is a decision rather than a
given.

`conditional` runs **inside**. A replayed idempotent request must return the
stored response bit for bit, and re-evaluating its preconditions against state
that has moved on would turn a replay into a 412. The original request's
preconditions were evaluated once, when they meant something. Outside, a client
could never retrieve the answer to a request that already succeeded — and the
test for it moves the state between the two calls, so the ordering is asserted
rather than assumed.

**A failed precondition does not spend the key**, and getting that right needed
a change in `idempotency` rather than here. The first version of that module
released a key on a 5xx and held it on a 4xx, justified as a 4xx being a
deterministic answer to a malformed request. **A 412 is not deterministic** — it
depends on server state, and a client that re-reads and sends a corrected
validator *should* get a different answer. Under the old rule that client was
stranded: it had to invent a new key to make progress on a request it had
already fixed.

Releasing is safe here for a reason **specific to 412** rather than a loosening
of the rule, and the ordering is what makes it structural: this position throws
*before* calling `next`, so nothing executed and there is no write to
double-apply. See [[idempotency]], where the rule and its table now live.

### 412 needed a `Kind` that did not exist

Case 29 requires 412; case 3's table has eleven statuses and no 412. **The same
contradiction decision 0010 resolved for 422**, found the same way — by
implementing the module that needs it.

`precondition_failed` is added here and marked **`Proposed`**, not `Accepted`:
the vocabulary is collection-wide, and this repository is not entitled to settle
it alone. See ADR 0011. That this is the *second* occurrence of the same class
of gap is itself worth the collection's attention.

## Example

```ts
// The RFC half, usable today.
const tag = unwrap(strongTagFor('application/json', representation));

// The domain half, which the first aggregate implements.
const validators: Validators = async (exchange) => {
  const current = await repository.load(idFrom(exchange));
  if (current === undefined) return undefined;
  return { etag: unwrap(strongTagFor(variantOf(exchange), current)) };
};

const handler = chain({ ..., conditional: conditional({ validators }) }, route);
```

## Gotchas

- **`W/` is case-sensitive.** The ABNF is `%s"W/"`, a case-sensitive literal.
  `w/"x"` is not a weak tag; it is not a tag at all, and accepting it would
  silently change which comparison applies.
- **A comma is legal inside an opaque-tag.** `%x2C` is inside `%x23-7E`, so
  `"a,b"` is one tag and `split(',')` makes it two malformed ones — rejecting
  the whole `If-Match` and 412-ing a caller who did nothing wrong. **The tags
  this repository emits are hex digests, so nothing it produces would ever
  surface that**: the bug only shows against a foreign tag, from a client that
  got its ETag from somewhere else.
- **A malformed `If-Match` is a 412, not an ignore.** Unlike a malformed date:
  the caller asked for a guard on a write, and a guard we cannot evaluate is a
  guard we must not skip. A malformed `If-None-Match` goes the other way — that
  header asks to avoid redundant work, so failing to parse it costs a transfer
  rather than a wrong write.
- **The 304 carries the validator.** §15.4.5: a 304 sends the header fields that
  would have been sent in a 200, which is how a cache updates stored metadata
  without a transfer. A 304 with no `ETag` leaves the cache exactly where it was.
- **A GET asks for a validator; an unconditional write does not.** Asking on
  every write would put a read in front of every mutation for nothing.
- **The whole digest, never a prefix.** A shortened digest is a validator with a
  birthday bound nobody wrote down. `sha256:<hex>` is 71 characters and every one
  is legal in an opaque-tag.
- **A raw U+001F got into `etag.ts` while it was being written**, invisible to
  `grep` and caught only by `tests/rules/encoding.test.ts`. Fourth time in this
  repository. The separator is an escape now, and the rule holds: never type a
  control character into a source file.

## Used in

- `src/shared/conditional/index.ts`

Every mutating endpoint, once contexts exist — `If-Match` is required on all of
them. **`Validators` has no implementation yet, and that is the point**: the
interface is what makes the first aggregate's obligation visible at the moment
it is written, rather than discovered afterwards. Two things it deliberately
does not decide, because the first aggregate will: whether collection endpoints
carry tags at all, and whether the tag is computed from a canonical
serialization or stored as a version column. Both satisfy the interface.

## Related

[[digest]] — RFC 8785 canonicalization, and the reason a **strong** tag is
available here at all. [[edge]] — the floor these types come from. [[httpx]] —
position 9, and the mapper the 412 goes through. [[idempotency]] — the other
occupant of position 9, and why this one runs inside it. [[errors]] — the
`precondition_failed` kind, proposed rather than settled.
