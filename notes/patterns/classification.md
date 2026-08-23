---
module: classification
layer: L3
---

# Classification

## What

A sensitivity vocabulary. A closed set of levels and a way to attach one to a
field.

```
public · internal · pii · secret · regulated
```

**Nothing more.** It makes no decisions, performs no I/O, and enforces nothing
on its own.

## Why

### It goes first because six modules read it

`redact`, `fieldcrypt`, `readaudit`, `retention`, `exports` and `cost` all need
an answer to *is an email address PII?* Built after them, there would be six
independent answers.

The specific failure is not abstract: **the export path disagreeing with the log
path**, which is how data leaves the building looking compliant. Retrofitting
means reconciling opinions that have already diverged rather than declaring one,
and the reconciliation is the expensive part — every consumer has tests pinning
its own opinion by then.

### Mechanism versus vocabulary — the layering, resolved rather than moved

`redact` is **L0** and `classification` is **L3**, so `redact` cannot import
this. `S1` forbids the upward import, permanently.

The temptation is to move `redact` up a layer to make the dependency legal.
Written down instead:

> **Redaction is a mechanism; classification is a vocabulary.**

`redact` knows *how* to make a value unprintable — four stringification paths, a
`#private` field, a cycle-safe walk. It has no business knowing *which* values
deserve that. And it is used by `logger` at L1: moving it up would drag `logger`
up with it, and `logger` cannot sit above the modules that log.

So the vocabulary is supplied at the first layer that can see both, and handed
to `redact` **as data**. The consumer holds the mapping; the mechanism stays
where everything can reach it.

### The levels are closed

Like `errors.Kind`, and for the same reason: a level ends up in canonical bytes
and in generated catalogs, so a growing enum is a **canonical-form change**. Add
one only with an ADR.

They are **ordered**, which is the useful part. A consumer asks *at or above
`pii`* rather than enumerating, so adding a level later does not silently narrow
every existing check. Different consumers use different thresholds against one
vocabulary — `exports` refuses at or above `secret`, `readaudit` records at or
above `pii`.

### Declaration, never inference

There is no heuristic over field names here and there must never be one. A
guesser that sees `email` and infers PII will also see `email_template_id` and
get it wrong **in the direction that leaks**.

`classify<T>` takes a `Record<keyof T, Level>`, so adding a field to a type and
forgetting to classify it **does not compile**. That is rule `M9` enforced by
the type system rather than a lint pass. Decorators were the other idiomatic
option and `erasableSyntaxOnly` forbids them — which turned out to be the better
constraint, because a decorator is opt-in per field and an exhaustive record is
opt-out per field.

What a type cannot catch is somebody *defeating* the record with `as`,
`Partial`, or a spread that fills the gap. That is what the `M9` AST rule
detects, and it landed with no contexts in the repository — the phase-0
principle, and the last moment it is free.

### An unclassified field is the most sensitive, not the least

An unlabelled field is **not public**. Guessing low means data leaves the
building looking compliant; guessing high means somebody has to add a label.
Only one of those is recoverable after the fact.

`UNCLASSIFIED` is therefore `regulated`. This is deliberately uncomfortable and
meant to be: a system that hits the default constantly has an incomplete
registry, which is the thing worth noticing.

### What it must not do

No encryption, no masking, no policy. It says a field is PII; it does not say
what happens to PII.

| Decision | Module |
| --- | --- |
| encryption | `fieldcrypt` |
| printing | `redact` |
| deletion | `retention` |
| visibility | `exports` |

A classification module that starts making those decisions has become five
modules wearing one name.

## Example

```ts
export const USER = classify<User>('identity.User', {
  id: Level.Internal,
  email: Level.Pii,
  displayName: Level.Pii,
  passwordHash: Level.Secret,
  cardNumber: Level.Regulated,
});
// Adding a field to `User` and not to this record is a compile error.

const registry = classification.registry(USER, ORG, SESSION);

// A consumer picks its own threshold against the one vocabulary.
redactClassified(payload, registry, Level.Pii);
registry.at(Level.Secret);   // -> ['identity.User.cardNumber', ...]
```

## Gotchas

- **`redact` matches a normalised key against a raw fragment.** It lowercases
  the key and strips separators, then does a substring test with the fragment as
  given — so a camelCase fragment matches nothing. `displayName` was in the
  sensitive list and being **printed in full** until `sensitiveKeys` normalised
  it. The retrofit looked wired and was not, and a test asserting the declared
  spelling is what caught it.
- **The retrofit unions with `redact`'s own list, it does not replace it.** The
  built-in fragments are a backstop for values that never went near a classified
  type — a raw header map, a third-party payload — and replacing them would
  quietly un-protect everything nobody has classified yet.
- **A type is classified once.** Two opinions about one type is the failure the
  module exists to prevent, so a duplicate registration throws at boot.
- **`levelOf` fails closed for an unknown *field* as well as an unknown type.**
  The case that matters is somebody adding a column and not a label.
- **Short field names meet `redact`'s segment rule.** A classified field named
  `id` or `pan` becomes a whole-segment fragment rather than a substring one —
  correct, and worth knowing before it surprises somebody.

## Used in

- `src/shared/classification/index.ts`
- `src/shared/redact/index.ts`

This list grows to `fieldcrypt`, `readaudit`, `retention`, `exports` and `cost`
— all of which read the vocabulary and none of which redefine it.

## Related

[[redact]] — the mechanism this supplies a vocabulary to, and the layering that
keeps them apart. [[errors]] — `Kind`, the other closed vocabulary, closed for
the same canonical-form reason. [[digest]] — why a growing enum is a
canonical-form change. [[strictness]] — `erasableSyntaxOnly` forbidding
decorators, which is why the declaration is an exhaustive record.
