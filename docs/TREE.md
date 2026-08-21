# Project Structure — modular-hx-ts

**This file is the build queue and the session state.** A new session reads it,
finds the first unticked box, and builds that.

*A stale tree is worse than none — it is what tells us what to build next.*
Rule **R3** checks it against the filesystem.

Tick a box when the file compiles, its tests pass, and it has a note.
Mark files to hand-type with `[hand]` up front — per file, not per mood.

---

## Phase 0 — Rules before code

**Nothing else starts until every box here is ticked.** On an empty repo these
pass trivially and need no allowlist. That is the only moment that is true.

- [x] `Makefile` — dev · test · lint · ci · infra-up · migrate
- [x] project manifest + toolchain pin
- [x] `docker-compose.yml` — postgres, health-gated, non-default host ports
- [x] `.env.example`
- [x] arch test — S1 layering · S5–S9 boundaries · S10 vendor confinement
- [x] docs test — N1 notes · N3 sections · N5 cited paths exist · R3 tree matches
- [x] CI workflow — no-infra jobs first, then integration, then e2e
- [x] `docs/decisions/0001` written and referenced by the arch test (rule D5)

## Phase 1 — L0 Kernel

Pure. No I/O, no process state. Runs with no fixtures, no fakes, no infrastructure.

- [x] `src/shared/errors/`
- [x] `src/shared/result/`
- [x] `src/shared/brand/`
- [x] `src/shared/assert/`
- [x] `src/shared/clock/`
- [x] `src/shared/id/`
- [x] `src/shared/random/`
- [x] `src/shared/retry/`
- [x] `src/shared/breaker/`
- [x] `src/shared/digest/`
- [x] `src/shared/pagination/`
- [x] `src/shared/buildinfo/`
- [x] `src/shared/redact/`

## Phase 2 — L1 Runtime

This process: configuration, logging, lifecycle, observability.

- [ ] `src/shared/provenance/`
- [ ] `src/shared/logger/`
- [ ] `src/shared/env/`
- [ ] `src/shared/secrets/`
- [ ] `src/shared/lifecycle/`
- [ ] `src/shared/health/`
- [ ] `src/shared/telemetry/`

## Phase 3 — L2 Substrate

**Each one: port + memory adapter + real adapter + one contract suite both pass.**
That is the layer's definition, not a convention inside it.

- [ ] `src/shared/postgres/`
- [ ] `src/shared/events/`
- [ ] `src/shared/jobs/`
- [ ] `src/shared/lock/`
- [ ] `src/shared/mailer/`
- [ ] `src/shared/httpclient/`

## Phase 4 — L3 Capability

Real decisions, no domain knowledge.
**`classification` before anything that reads it.**

- [ ] `src/shared/authz/`
- [ ] `src/shared/tenant/`
- [ ] `src/shared/crypto/`
- [ ] `src/shared/classification/`
- [ ] `src/shared/flags/`

## Phase 5 — L4 Edge

- [ ] `src/shared/httpx/`
- [ ] `src/shared/idempotency/`
- [ ] `src/shared/ratelimit/`
- [ ] `src/shared/conditional/`
- [ ] `src/shared/openapi/`

## Phase 7 — Contexts

Constant set first. `audit` is the proof the event plumbing works end to end —
and it imports nothing.

- [ ] `src/contexts/identity/` — users, sessions, roles, challenges, API keys
- [ ] `src/contexts/audit/` — subscribes to every context; idempotent by event id
- [ ] `src/contexts/orgs/` — multi-org membership, role per scope, one owner always

### Showcase

- [ ] `src/contexts/lineage/`
- [ ] `src/contexts/inbound/`
- [ ] `src/contexts/webhooks/`
- [ ] `src/contexts/exports/`

## Phase 8 — Composition root

- [ ] `src/wire.ts` — the only place that knows concrete types
- [ ] `policy` — the one authz policy, validated at boot
- [ ] `config` — the storage switch
- [ ] `migrations` — registry of every context's set
- [ ] `seed` — realistic demo data. **A blueprint that boots empty makes a bad
      first impression**

## Phase 9 — Verification

- [ ] `STORAGE=memory` runs the whole app with zero dependencies (conformance 47)
- [ ] Integration suites green against real Postgres
- [ ] e2e green against the real binary
- [ ] `../conformance` runner green
- [ ] `notes/INDEX.md` generated and current

---

## Later — deferred, with triggers

**A deferral without a trigger is an omission** (rule M11).

| Module | Trigger |
| --- | --- |
| `work` | Durable out-of-band tasks — exports, indexing, webhook delivery |
| `dlq` | The second thing that can dead-letter |
| `backlog` | Anything can fall behind |
| `cache` | A measured need, or a second instance where in-process is wrong |
| `blob` | Anything is stored as a file — **note: identity avatars alone pull this in** |
| `search` | Anything is queried by free text |
| `quota` | The product has plans, limits, or metered consumption |
| `attest` | This blueprint gains a data-provenance story |
| `deadline` | The first timeout that should have been a budget |
| `operations` | The first async endpoint |
| `llm` · `prompts` · `tokens` · `evals` | The first model-backed feature |
| `oidc` · `saml` · `mfa` | The first enterprise buyer |
| `maintenance` | The first migration that cannot run online |
| `backfill` | The first schema change needing data moved |
| `scaffold` | The third bounded context |

## File descriptions

Filled in as files are created. **Rule R3 requires every source file to appear
here and every listed file to exist.**

### Root

| File | Description |
| --- | --- |
| `.gitignore` | Dependencies, build output, environment files, editor state, and local working files that are not part of the published blueprint. `.env.example` is committed; `.env` never is |
| `.github/workflows/ci.yml` | Four jobs, no-infra first so most failures land before a container starts: `make ci`, `make audit`, then integration and e2e against Postgres as a service container. Node and pnpm come from `.nvmrc` and `packageManager`, so CI cannot drift from a developer's machine. Same image and tag as compose; the tuning flags compose passes via `command:` are the one thing a service container cannot express, and the file says so |
| `Makefile` | The interface to the verification ladder. Rung 0 (`dev`, `test`) needs no infrastructure; rungs 1–3 (`migrate`, `test-integration`, `e2e`) need Postgres. `ci` is every check a push must pass without Docker. Host ports come from `../PORTS.md` (this repo's base is 15420) and are env-overridable. Compose targets cover Postgres only — Mailpit and Jaeger/Prometheus targets land with `mailer` and `telemetry` |
| `package.json` | Manifest. `type: module`, `packageManager` and `engines` pin the toolchain. Scripts are only the ones the Makefile calls — `make` is the interface, so there is one door per job. `dependencies` is empty on purpose: a runtime dependency arrives with the module that needs it. **Two TypeScripts on purpose**: `typescript7` (aliased 7.0.2, the native compiler) builds and typechecks, while `typescript` 6.0.3 is what `typescript-eslint` and `dependency-cruiser` read the AST with — typescript-eslint has no TS 7 support, so this is the side-by-side layout TS 7 ships for. `tsc` on `PATH` is therefore ambiguous; every script names the compiler by path instead |
| `pnpm-lock.yaml` | Resolved dependency graph. Committed; `make install` uses `--frozen-lockfile` |
| `pnpm-workspace.yaml` | pnpm's own settings (pnpm 11 reads them here). Postinstall scripts run only for dependencies named in `allowBuilds`; `minimumReleaseAgeExclude` records every version deliberately taken newer than the supply-chain gate |
| `.nvmrc` | Node pin, exact. Read by `nvm` and by `actions/setup-node` in CI, so local and CI cannot drift |
| `.npmrc` | `engine-strict` — the wrong Node fails at install, not three rungs up the ladder |
| `tsconfig.json` | Typechecking, no emit. Strict plus every flag above it that catches real bugs; `erasableSyntaxOnly` keeps the program identical for tsc, esbuild and native type stripping. Covers `src`, `tests` and the config files |
| `tsconfig.build.json` | Emit only. `src` → `dist` as plain ESM that `node` runs with no loader and no flags — what rungs 3 and 4 actually execute |
| `vitest.config.ts` | The ladder as three projects: `unit` (no infrastructure, and where the rule suites live), `integration`, `e2e`. `make test`, `make test-integration` and `make e2e` select between them |
| `docker-compose.yml` | The local stack for rungs 1–3. `postgres:18-alpine`, pinned by tag — note this diverges from `../INFRASTRUCTURE.md` §2.1, which still records `postgres:16-alpine` for the collection; the deviation is recorded in `docs/decisions/0002-postgres-18.md`. Postgres only — the one service a phase-1 module has a contract suite to run against; Mailpit arrives with `mailer`, Jaeger and Prometheus with `telemetry`. Image pinned by tag, health-gated so `--wait` means something, host port `15420` — `../PORTS.md` base 15420, Postgres at offset +0 — overridable via `PG_PORT`, named volume destroyed only by `db-reset`/`infra-reset`, mounted at `/var/lib/postgresql` because 18 moved the data into a version-named subdirectory below the mount. `--locale=C` so `ORDER BY` means the same thing here, in CI and on every machine — keyset pagination depends on it. `fsync=off` and friends are deliberate: rung 2's database is disposable, and that trade stays out of `deploy/` |
| `.env.example` | Every environment variable with its memory default, each labelled with the module that reads it. An empty `.env` is valid — the defaults run the whole application with nothing installed, which is acceptance criterion 1 as a file. The commented rung-2 block is the entire switch to real infrastructure, and it is config, not a code path |
| `.dependency-cruiser.cjs` | S1-S10 as import-graph rules, plus `no-circular`. Anchored on `src/` and cruised with a `baseDir`, so one rule set governs the real tree and the fixture trees alike. Its config schema forbids extra keys, which is why the layer table lives next door |
| `layers.cjs` | The layer of every shared module, and the vendor SDK table. One source of truth read by two independent enforcers: the S1/S10 rules above, and the docs test that checks each module note names the same layer (N7) |
| `eslint.config.ts` | Lint, type-aware from the start via `strictTypeChecked`. Deliberately holds no architecture rules — S rules are import-graph rules and belong to dependency-cruiser, M rules are AST rules and belong to `tests/rules/`. Each class of rule sits in the tool that can express it |
| `.prettierrc.json` · `.prettierignore` | Formatting, enforced by `make fmt-check` inside `make ci`. Markdown is excluded — prettier normalizes `*emphasis*` to `_emphasis_` and reflows ASCII tables, diverging this repo from the collection's documents |

### Shared kernel

| File | Description |
| --- | --- |
| `src/shared/errors/index.ts` | **L0.** Kind-tagged errors: a closed vocabulary of ten kinds, `wrap` that adds context per layer while preserving the kind, and `isRetryable` decided once so `retry` and `breaker` cannot disagree. Deliberately holds no status codes — invariant I7 maps kinds to transport codes only in transport, and this is the module where that erodes first. The only module a context's `domain/` may import (rule S7). Note: `notes/patterns/errors.md` |
| `src/shared/result/index.ts` | **L0.** `Result<T, E = AppError>` as a discriminated union with standalone helpers — no methods, so it survives `JSON.stringify` and crosses a process boundary. `attempt`/`attemptAsync` are the adapter boundary in one function: third-party code throws, this side returns classified values. Imports `errors` sideways within L0, which `S1` permits and `../ARCHITECTURE.md` §2 asks be flagged. Note: `notes/patterns/result.md` |
| `src/shared/result/index.test.ts` | 23 unit tests, including the JSON round-trip that justifies the union over a class, and both non-`Error` failure paths that real drivers produce |
| `src/shared/brand/index.ts` | **L0.** Nominal types on a structural type system. The tag is a `declare`d `unique symbol`, so a brand is erased entirely — a `UserId` **is** a `string` at runtime. `defineBrand(name, predicate)` makes the predicate the definition of the type, so a function taking a `UserId` needs no defensive check. Note: `notes/patterns/brand.md` |
| `src/shared/brand/index.test.ts` | 15 tests. The three that carry the module are type-level `expectTypeOf` assertions — the behaviour is invisible at runtime, so they are checked by `make typecheck` rather than by the test run |
| `src/shared/assert/index.ts` | **L0.** `invariant` · `assertDefined` · `must` · `assertNever` · `unreachable`. All throw `Internal`, which is the other half of the rule `result` encodes: a failure you expected is a value, one you did not is a throw. `assertNever` turns a new union member into a compile error rather than an accidental 500. Note: `notes/patterns/assert.md` |
| `src/shared/assert/index.test.ts` | 16 tests. Pins the deliberate asymmetry — `assertDefined` accepts `0`/`''`/`false` while `invariant` rejects them — and asserts that a structural value never reaches a message, secrets included |
| `src/shared/clock/index.ts` | **L0.** Time behind a port, per invariant I5 — the only file permitted to read `Date.now`, `new Date()` or `performance.now()`. Exposes wall-clock and monotonic time separately, because subtracting two wall-clock readings computes a negative duration whenever NTP steps the host backwards. `fakeClock` only moves when a test moves it, so an hour of backoff costs a millisecond. `Millis` is branded so seconds cannot be passed where milliseconds are meant. Note: `notes/techniques/clock.md` |
| `src/shared/clock/index.test.ts` | 17 tests. The load-bearing one advances ten seconds, jumps the wall clock back six years, and asserts the monotonic reading still says ten seconds |
| `src/shared/id/index.ts` | **L0.** UUIDv7 behind a port, per invariant I5. Time-ordered so an id column is a usable sort key — a B-tree appends rather than fragmenting, and keyset pagination over it is chronological. Monotonic inside a millisecond via RFC 9562 §6.2 method 1, because a burst of inserts is exactly when ordering silently stops holding. Declares `RandomBytes` itself: `random` is not built yet, and the consumer owns the interface. Note: `notes/techniques/id.md` |
| `src/shared/id/index.test.ts` | 21 tests. 500 ids inside one frozen millisecond sort correctly and are distinct; a golden encoding value pins the RFC byte layout; the 4096-per-millisecond counter wrap is a tested boundary rather than a surprise |
| `src/shared/random/index.ts` | **L0.** The one CSPRNG, per invariant I5 — so `Math.random()` anywhere else reads as an anomaly rather than an idiom. `int` uses rejection sampling because `draw % max` skews toward low residues. `constantTimeEqual` wraps `node:crypto`'s `timingSafeEqual` rather than hand-rolling the loop, since a hand-written accumulator is correct on paper and at the mercy of the JIT. Note: `notes/techniques/random.md` |
| `src/shared/random/index.test.ts` | 20 tests. Uniformity is measured over 60,000 draws rather than asserted; the 200,000-byte draw proves chunking past the platform's 65,536 single-call limit; `constantTimeEqual` is checked against `===` on every case, including ones differing only in the first or last byte |
| `src/shared/retry/index.ts` | **L0.** Kind-aware backoff with full jitter. Repeats only failures `errors.isRetryable` calls transient, so `retry` and `breaker` cannot drift apart. `random(0, min(cap, base × 2^(n-1)))` — full rather than equal jitter, because equal jitter's floor keeps every client inside the same window and the herd re-forms. Clock and randomness injected, so an hour of backoff is verified in a millisecond. Note: `notes/techniques/retry.md` |
| `src/shared/retry/index.test.ts` | 19 tests. Jitter spread and decorrelation are measured rather than asserted; a 24-hour simulated backoff completes in under two seconds of real time; overflow is pinned at attempt 5,000 |
| `src/shared/breaker/index.ts` | **L0.** Keyed circuit breaker over a rolling window, with one half-open probe. The window is the point: a consecutive-failure counter resets on every success, so a dependency failing half its calls never trips — and that flapping case is the one that fills a connection pool. Counts only failures `errors.isRetryable` calls transient, so `retry` and `breaker` share one definition. `onStateChange` satisfies invariant I9's requirement that the control be visible when it fires. Note: `notes/techniques/breaker.md` |
| `src/shared/breaker/index.test.ts` | 16 tests. The load-bearing one alternates failure and success and asserts the circuit opens — a consecutive counter would sit at one forever |
| `src/shared/digest/index.ts` | **L0.** Canonical JSON per RFC 8785 and `sha256:` content identities. `JSON.stringify` preserves insertion order, so two objects with the same fields hash differently depending on how they were built — that single fact is why this exists. Refuses `undefined`, `NaN`, `Date`, `Map` and cycles rather than guessing, because each guess is a divergence that shows up as a mismatched identity long after the cause. Note: `notes/techniques/digest.md` |
| `src/shared/digest/index.test.ts` | 19 tests. Reproduces RFC 8785's published worked example byte for byte, and pins one digest against a hash that `shasum` and `openssl` both independently confirm |
| `src/shared/pagination/index.ts` | **L0.** Keyset cursors. `OFFSET` is O(offset) *and* incorrect under concurrent writes — an insert before the offset makes the reader skip a row, a delete makes it see one twice, and the symptom is a missing record nobody knew to look for. A cursor names a position in the data, so concurrent writes cannot shift it. Carries its ordering, so one listing's cursor cannot be replayed against another. Note: `notes/techniques/pagination.md` |
| `src/shared/pagination/index.test.ts` | 20 tests. Walks 25 rows through 3 pages and asserts every row appears exactly once and in order; pins the exactly-full-page and cursor-position off-by-ones that would each skip or repeat a row per boundary |
| `src/shared/buildinfo/index.ts` | **L0.** Name, version, commit, build time, dirty flag — the answer to "what is actually deployed", in the startup line, at `/version`, and in every outbound `User-Agent`. Reads no environment: `process.env` is L1's concern, so the root passes values in, which is also what makes the formatting testable without a build. Fails open per invariant I9 — a bad stamp degrades to `unknown` rather than stopping a boot during a rollback. Note: `notes/patterns/buildinfo.md` |
| `src/shared/buildinfo/index.test.ts` | 17 tests. Seven shapes of garbage input assert it never throws, and an unsubstituted `$COMMIT` becomes `unknown` rather than being echoed as if it were a sha |
| `src/shared/redact/index.ts` | **L0.** One place for "this must never print" — the `×5` harvest module. A `Secret` is unprintable by construction across all four paths from a value to text: `Symbol.toPrimitive`, `toString`, `toJSON`, and `nodejs.util.inspect.custom`, with the value in a `#private` field. `util.inspect` is the one most implementations miss, and it ignores `toString` entirely. `expose()` is deliberately ugly so every call site is greppable. Note: `notes/patterns/redact.md` |
| `src/shared/redact/index.test.ts` | 23 tests, one per leak path. Found two real defects: hyphenated keys like `X-Api-Key` slipped the fragment list, and `Secret` declared its stringification only on the class, so the type system could not see the guarantee |
| `src/shared/errors/index.test.ts` | 26 unit tests. Four exist to pin decisions that would otherwise erode: a conflict is not retryable, an absent `cause` is not `cause: undefined`, `wrap` survives a thrown non-Error, and `chain` terminates on a cycle |

### Rules

| File | Description |
| --- | --- |
| `tests/rules/arch.test.ts` | Proves every rule in `.dependency-cruiser.cjs` actually fires. On an empty repo the cruise passes vacuously, and a rule that has never fired is a rule nobody has tested — so each one also gets a tree built to trip it. Three tests carry the weight: a clean tree reports nothing, each fixture trips exactly one named rule, and no rule ships without a fixture |
| `tests/rules/semantic-rules.ts` | Rules about what the code does rather than what it imports, so they parse the syntax tree with ts-morph rather than the import graph. `M2`: no module reads `Date.now`, `performance.now` or zero-argument `new Date()` — `new Date('2026-01-01…')` is allowed, because naming an instant is not reading one. `I5`: only `random` touches entropy. **`I5` is named for the invariant, not for an `M` number** — `../ENFORCEMENT.md` covers the clock half of I5 and not the randomness half, and minting a local rule id would put this repo's rule set out of step with its siblings. It renames if the collection gives it one |
| `tests/rules/semantic.test.ts` | Runs the M rules against this repository and against a fixture per rule, including a `clean/` tree that exercises both exemptions — the `clock` module, and a literal date |
| `tests/rules/docs-rules.ts` | The N, D and R rules as functions over a repository root, so the same checks run against this repo and against fixture roots. Its header records the rules deliberately not implemented yet and why |
| `tests/rules/docs.test.ts` | Runs those rules against this repository — which must satisfy every one — and against a fixture per rule. The repository test is the one that fires when a document drifts, which is what N5 and R3 exist for |
| `tests/rules/fixtures/` | One directory per rule. `arch/` holds minimal `src/` trees that each violate one import rule; `docs/` holds minimal repository roots that each violate one document rule. Both carry a `clean/` control that violates none. Excluded from `tsc`, ESLint and `make arch` — they are broken on purpose |

### Rules not yet enforced

**A rule deferred needs a reason, the same way a module deferred needs a
trigger.** Sixteen of the N, D and R rules are enforced today, alongside all
nine S rules; these are not, and none of them is an oversight.

| Rule | Why not yet | Lands |
| --- | --- | --- |
| **N8** · `notes/INDEX.md` is current | There is no generator to diff against | Phase 9, with the generator |
| **R1** · README has the standard sections | Installation, Quick Start, Usage, Configuration and Requirements would be fiction — nothing runs yet | When `make dev` serves a request |
| **R2** · ARCHITECTURE names every module with its layer | The document says so itself: *"to be completed as the repo is built"* | Progressively, as modules land |
| **An `M` id for `I5`** | `../ENFORCEMENT.md` has M2 for the clock half of invariant I5 and nothing for randomness or identifiers. The detection exists here under the invariant's own id rather than a locally-minted number | When the collection assigns one |
| **M1, M3–M11** | Each needs the thing it governs. M1 needs a port with two adapters, M3 a repository, M4 a use case, M5 an event envelope — a rule written first would have nothing to parse and no fixture worth writing | With the module that defines it |
| **D3** · Accepted ADRs are immutable | Needs history, not the working tree. `git log` knows; a file-parsing test cannot | Never — a review habit |
| **D6** · When an ADR is required | A judgement about a decision, not a property of a file | Never — a review habit |
| **R8** · `STATUS.md` is current | Gitignored, so CI cannot see it. `../ENFORCEMENT.md` states this limit rather than pretending otherwise | Never — a session habit |
