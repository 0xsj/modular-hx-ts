# ADR 0002 — PostgreSQL 18

**Status:** Accepted · **Date:** 2026-08-21

## Context

`../INFRASTRUCTURE.md` §2.1 records `postgres:16-alpine` as the image for every
blueprint in the collection, and §3 rule 1 requires the image be pinned by tag.
This repo runs `postgres:18-alpine` instead. The collection document is
normative and has not changed, so the deviation is recorded here — an unlisted
deviation is a bug, not a preference.

This is a storage-version decision, not an architecture one. ADR 0001 remains
the architecture record.

## Decision

`docker-compose.yml` and every CI job run **`postgres:18-alpine`**, pinned by
tag, and the two stay identical (`../INFRASTRUCTURE.md` §3 rule 5 — an image
that differs between CI and compose is testing something nobody can reproduce
locally).

What 18 brings that 16 does not, in the order it matters here:

- **`data_checksums` on by default.** Tamper and corruption evidence at rest,
  with no configuration. A data-integrity control that fails closed is one this
  blueprint would otherwise have to argue for.
- **Asynchronous I/O.** The read path stops being one blocking syscall at a
  time, which is the difference the contract suites will feel first.
- **`uuidv7()` and `uuid_extract_timestamp()` as built-ins.** Convenience, not a
  dependency: the `id` module is L0 and pure, so it generates identifiers
  in-process and Postgres never issues one. The value is that the database can
  now decode the timestamp inside an id we generated, which makes a keyset
  pagination bug readable in `psql`.

## Alternatives considered

- **Stay on 16, as the collection says.** Rejected. It keeps the sibling repos
  byte-identical on storage, but a blueprint pinned four majors back teaches the
  wrong lesson about what "production-grade" means, and 18 is where checksums
  stop being an argument.
- **17.** Rejected: it is a step with no reason attached. If the collection is
  going to carry the cost of a divergence, it should buy the current release.
- **The non-alpine image.** Rejected: larger, and nothing here needs glibc.
- **Change `../INFRASTRUCTURE.md` instead.** Rejected for now. Editing a
  collection document from inside one repo would either force `modular-hx-go`
  to follow immediately or record drift in the document that exists to prevent
  it. Recording the deviation locally leaves that decision where it belongs.

## Consequences

- **The thesis takes a real hit, and it must be said plainly.** This repo exists
  to show *"the same architecture where the language is the variable and nothing
  else is."* Running 18 here while `modular-hx-go` runs 16 makes storage a
  second variable. Any conformance difference between the two repos now has two
  candidate explanations rather than one. That cost is accepted on the
  understanding that `modular-hx-go` follows to 18; until it does, the
  comparison is weaker than the README claims.
- **The volume mount moved.** 18 places data in a major-version-named
  subdirectory, so the mount is `/var/lib/postgresql`, not
  `/var/lib/postgresql/data`. Mounting the old path leaves the server reporting
  an unused volume and failing its health check. This is also what makes
  `pg_upgrade --link` possible later without crossing a mount boundary.
- **An existing 16 volume cannot be reused.** `make db-reset` destroys it, which
  is the only target permitted to.
- `postgres:16-alpine` remains correct for the collection until
  `../INFRASTRUCTURE.md` §2.1 says otherwise. This repo is the exception.

## Enforced by

**None directly.** This is a version decision, not a structural one, and no rule
in `../ENFORCEMENT.md` has anything to say about an image tag. What holds it
together is `../INFRASTRUCTURE.md` §3 rule 5 — CI and compose use the same image
— and that is a review obligation here, not a test. The `image:` line appears in
exactly two files, and both are named in this ADR.

## Verification

- `make db-up` health-gates on `pg_isready` over TCP, so a version mismatch
  fails the gate rather than producing a container that looks healthy. This is
  what caught the mount-point change.
- Confirmed on 18.6: `C` collation, UTF8 encoding, `data_checksums=on`, and
  every tuning flag in `docker-compose.yml` applied.
- **Not verified:** that 18 is behaviour-compatible with 16 for everything this
  blueprint does. Nothing uses Postgres yet. The claim becomes testable when the
  L2 contract suites run against a real adapter at rung 2, and it is those
  suites — one suite, both adapters — that will settle it. Until then this ADR
  asserts a version, not a compatibility.
