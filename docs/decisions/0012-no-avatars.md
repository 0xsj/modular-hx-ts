# ADR 0012 — `identity` ships without avatars

**Status:** Accepted · **Date:** 2026-08-24

## Context

`../CONTEXTS.md` §2.4 names avatars as *the one extension worth arguing about*
and asks each blueprint to decide and record it:

> Every other part of identity is universal; avatars are not, and they are what
> pulls `blob` — a whole substrate module — into the baseline.

The asymmetry is the argument. Users, sessions, roles, credentials and the
emailed-secret lifecycle are needed by every product that has accounts. An
avatar is needed by products with a social surface, and it is the only part of
`identity` whose absence nobody notices until a designer asks for it.

**What it actually costs is not the column.** It is `blob`: a storage port, two
adapters, presigned-URL generation, a content-type allowlist, an image-size
limit, an EXIF-stripping step, a virus-scanning question, a CDN question, and a
lifecycle for orphaned objects when a user is deleted. `docs/TREE.md` already
records the trigger — *anything is stored as a file* — and notes that **identity
avatars alone pull this in**, which is exactly the entry this decision is about.

There is a second cost that is easy to miss. An avatar is user-supplied content
served back to other users, which makes it a stored-XSS surface if the
content-type is ever wrong, and a tracking surface if it is served from the
application's own origin with the caller's cookies attached. Those are real
decisions, and a blueprint that ships avatars without making them is teaching
the wrong lesson.

## Decision

**No avatars in this blueprint.** `identity` ships with everything else §2 names
and no `blob`.

## What would change my mind

Recorded because "no" without a trigger is the same omission rule `M11` forbids
for deferred modules:

- **The first showcase context that genuinely needs file storage.** `exports` is
  on this repository's list, and a streaming export is a `blob` consumer with a
  much better justification than a profile picture. Once `blob` exists for a
  reason of its own, avatars are a column and a route rather than a substrate
  module, and the argument here evaporates.
- **A conformance case that requires them.** None of cases 5–17 mentions an
  avatar, and if one is added this decision is superseded rather than argued.
- **Evidence that the collection's blueprints diverge on it.** The point of
  eight blueprints is that they satisfy the same suite; if half ship avatars and
  half do not, the interesting question is whether §2.4 should decide it centrally
  rather than per repository.

What would **not** change it: a product wanting one. This is a blueprint, and
the thing it is demonstrating is the architecture rather than the feature set.

## Alternatives considered

- **Ship an avatar URL field and no storage** — the user supplies a link we
  render. Rejected, and it is the tempting one because it looks free. It is a
  server-side request forgery surface if anything ever fetches the URL, a
  tracking beacon for whoever hosts it, and it teaches that a URL from a user is
  a value you can store and serve. The honest version of "no avatars" is no
  field.
- **Ship `blob` with only a memory adapter**, leaving the real one for later.
  Rejected: it fails `I2` — an L2 module has a port, a memory adapter, a real
  adapter and one contract suite both pass, and half of that is not a module.
  It would also make `STORAGE=memory` the only working mode for one feature,
  which is the kind of asymmetry that surfaces in production.
- **Defer the decision.** Rejected because §2.4 asks for it explicitly, and
  because an undecided extension is one somebody adds in a hurry when a
  designer asks — which is precisely when the content-type and origin questions
  get skipped.

## Consequences

- `blob` stays in `docs/TREE.md`'s deferred table with its existing trigger, and
  the note there that identity avatars alone would pull it in is now backed by a
  decision rather than an observation.
- `User` has no avatar field, and adding one later is a migration plus a route
  rather than a redesign — the aggregate is versioned and the view is separate
  from it.
- This blueprint's conformance profile is unaffected: no case covers avatars.
- If a sibling blueprint ships them, the two diverge on a feature rather than on
  the architecture, which is the divergence §2.4 is willing to accept.

## Verification

Nothing to verify — this is a decision not to build something, and the absence
of a feature is not testable in a way that means anything.

What *is* checkable, and is: `docs/TREE.md` lists no `blob` module, and the
deferred table names its trigger — which the docs test enforces.

## Enforced by

Nothing structural. `../ENFORCEMENT.md` has no rule for scope decisions, so none
is cited and none is invented.

The nearest mechanical control is the deferred-table rule — a deferral without a
trigger is an omission — which covers `blob`'s row rather than this decision
about the feature that would pull it in.
