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

**Landed early, deliberately:** `src/main.ts`. The composition root belongs to
phase 8, but a process that boots and stops is what lets each L1 module be
exercised for real as it is built rather than only through unit tests. It stays
a skeleton until phase 8, and every placeholder in it names the module that
replaces it — `env` for configuration, `logger` for output, `lifecycle` for
ordered shutdown, `httpx` for a server that actually listens.

- [x] `src/shared/provenance/`
- [x] `src/shared/logger/`
- [x] `src/shared/env/`
- [x] `src/shared/secrets/`
- [x] `src/shared/lifecycle/`
- [x] `src/shared/health/`
- [x] `src/shared/telemetry/`

## Phase 3 — L2 Substrate

**Each one: port + memory adapter + real adapter + one contract suite both pass.**
That is the layer's definition, not a convention inside it.

- [x] `src/shared/postgres/` — with `testx`; one unit of work
- [x] `src/shared/events/` — port + memory + outbox, one contract suite
- [x] `src/shared/jobs/` — with `lock`; one unit of work
- [x] `src/shared/lock/` — port + memory + postgres advisory
- [x] `src/shared/mailer/` — port + memory + smtp + none, one contract suite
- [x] `src/shared/httpclient/` — **L2 complete**

## Phase 4 — L3 Capability

Real decisions, no domain knowledge.
**`classification` before anything that reads it.**

- [ ] `src/shared/authz/`
- [ ] `src/shared/tenant/`
- [ ] `src/shared/crypto/`
- [x] `src/shared/classification/` — **first in L3**, and before its consumers
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
| `tsconfig.build.json` | Emit only, and test tooling is excluded so it cannot ship. `src` → `dist` as plain ESM that `node` runs with no loader and no flags — what rungs 3 and 4 actually execute |
| `vitest.config.ts` | The ladder as three projects: `unit` (no infrastructure, and where the rule suites live), `integration`, `e2e`. `make test`, `make test-integration` and `make e2e` select between them |
| `docker-compose.yml` | The local stack for rungs 1–3. Postgres and **Mailpit**, the two services a phase-1 module has a contract suite to run against; Mailpit arrived on the same change as `mailer`, which is `../INFRASTRUCTURE.md` §3 rule 7 working in the direction it was written for. Mailpit is health-gated like Postgres — its probe is its own binary, since the image ships no shell — and binds `../PORTS.md` +2 and +3. `postgres:18-alpine`, pinned by tag — note this diverges from `../INFRASTRUCTURE.md` §2.1, which still records `postgres:16-alpine` for the collection; the deviation is recorded in `docs/decisions/0002-postgres-18.md`. Postgres only — the one service a phase-1 module has a contract suite to run against; Mailpit arrives with `mailer`, Jaeger and Prometheus with `telemetry`. Image pinned by tag, health-gated so `--wait` means something, host port `15420` — `../PORTS.md` base 15420, Postgres at offset +0 — overridable via `PG_PORT`, named volume destroyed only by `db-reset`/`infra-reset`, mounted at `/var/lib/postgresql` because 18 moved the data into a version-named subdirectory below the mount. `--locale=C` so `ORDER BY` means the same thing here, in CI and on every machine — keyset pagination depends on it. `fsync=off` and friends are deliberate: rung 2's database is disposable, and that trade stays out of `deploy/` |
| `.env.example` | Every environment variable with its memory default, each labelled with the module that reads it. An empty `.env` is valid — the defaults run the whole application with nothing installed, which is acceptance criterion 1 as a file. The commented rung-2 block is the entire switch to real infrastructure, and it is config, not a code path |
| `.dependency-cruiser.cjs` | S1-S10 as import-graph rules, plus `no-circular`. `S3` covers two test-tooling suffixes — `.contract.ts` and `.testkit.ts` — because TypeScript has no package-private, so the boundary Go gets from a `_test` package has to be a rule here. Anchored on `src/` and cruised with a `baseDir`, so one rule set governs the real tree and the fixture trees alike. Its config schema forbids extra keys, which is why the layer table lives next door |
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
| `src/shared/clock/index.ts` | **L0.** Time behind a port, per invariant I5 — the only file permitted to read `Date.now`, `new Date()` or `performance.now()`. Exactly two readings, `now()` and `elapsed()`, with the surface fixed by `../MODULES.md` rather than chosen locally; waiting is deliberately off the port, so a consumer declares its own. Exposes wall-clock and monotonic time separately, because subtracting two wall-clock readings computes a negative duration whenever NTP steps the host backwards. `fakeClock` only moves when a test moves it, so an hour of backoff costs a millisecond. `Millis` is branded so seconds cannot be passed where milliseconds are meant. Note: `notes/techniques/clock.md` |
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
| `src/shared/digest/index.test.ts` | 34 tests. Reproduces RFC 8785's published worked example byte for byte, and pins one digest against a hash that `shasum` and `openssl` both independently confirm. The last 15 are **not ours**: the collection's cross-language vectors from `../conformance/fixtures/canonical-json.json`, verified across Python, Go and TypeScript before being committed and asserted here as hex **and** digest. They exist because a suite written beside its implementation cannot detect that both are wrong in the same way — which is how the collection lost `err_kind` in five repositories at once, each with a green suite. Read in place rather than copied, and **skipped by name** in a checkout without the sibling directory; they vendor into `docs/` with publication, alongside the root documents |
| `src/shared/pagination/index.ts` | **L0.** Keyset cursors. `OFFSET` is O(offset) *and* incorrect under concurrent writes — an insert before the offset makes the reader skip a row, a delete makes it see one twice, and the symptom is a missing record nobody knew to look for. A cursor names a position in the data, so concurrent writes cannot shift it. Carries its ordering, so one listing's cursor cannot be replayed against another. Note: `notes/techniques/pagination.md` |
| `src/shared/pagination/index.test.ts` | 20 tests. Walks 25 rows through 3 pages and asserts every row appears exactly once and in order; pins the exactly-full-page and cursor-position off-by-ones that would each skip or repeat a row per boundary |
| `src/shared/buildinfo/index.ts` | **L0.** Name, version, commit, build time, dirty flag — the answer to "what is actually deployed", in the startup line, at `/version`, and in every outbound `User-Agent`. Reads no environment: `process.env` is L1's concern, so the root passes values in, which is also what makes the formatting testable without a build. Fails open per invariant I9 — a bad stamp degrades to `unknown` rather than stopping a boot during a rollback. Note: `notes/patterns/buildinfo.md` |
| `src/shared/buildinfo/index.test.ts` | 17 tests. Seven shapes of garbage input assert it never throws, and an unsubstituted `$COMMIT` becomes `unknown` rather than being echoed as if it were a sha |
| `src/shared/redact/index.ts` | **L0.** One place for "this must never print" — the `×5` harvest module. A `Secret` is unprintable by construction across all four paths from a value to text: `Symbol.toPrimitive`, `toString`, `toJSON`, and `nodejs.util.inspect.custom`, with the value in a `#private` field. `util.inspect` is the one most implementations miss, and it ignores `toString` entirely. `expose()` is deliberately ugly so every call site is greppable. Note: `notes/patterns/redact.md` |
| `src/shared/redact/index.test.ts` | 31 tests, one per leak path. Found three real defects: hyphenated keys like `X-Api-Key` slipped the fragment list; `Secret` declared its stringification only on the class, so the type system could not see the guarantee; and a fragment of three characters matched as a substring, so `pan` redacted `span` in a real telemetry log line. Short fragments now match a whole segment — `card_pan` still redacts, `span` and `panel` do not |
| `src/main.ts` | **L5 composition root**, landed early (see phase 2). `migrate` runs the real migrator against `DATABASE_URL` over an empty registry — every context contributes its set as it lands, and the run still connects, takes the advisory lock and ensures `schema_migrations`, so the path is exercised on every deploy rather than first exercised by the first migration. Exits `78` without a DSN, which is what keeps the smoke test hermetic. Runs every command inside an origin — `system:boot`, `system:migrate` — so a line emitted by code that never asked for provenance still carries it. The only place that knows concrete types and the only place that reads the environment; rule `S9` keeps anything from importing it. Five commands — `serve`, `version`, `secrets`, `migrate`, `doctor` — with shutdown owned by `lifecycle` rather than hand-rolled — `health` registered last so draining is the first thing shutdown does — and with configuration loaded once through `env` — secret references resolved first by `secrets` — and a bad environment exiting `78` (`EX_CONFIG`) after naming every problem from both modules together. `version` and `secrets` deliberately need no configuration — the moment somebody asks what is deployed is usually the moment it is broken, and a broken reference is *why* configuration will not load, so the command that diagnoses it cannot depend on it. so `make dev`, `make start` and `make migrate` all do something real. `doctor` exercises every wired dependency and reports what happened, which is the operational answer to "is this deploy wired correctly"; it is not a health check, and `health` (L1) brings the probes a running process needs. Exports `main` and `wireKernel` and boots only when executed directly, which is what lets the smoke test import it |
| `src/shared/errors/index.test.ts` | 26 unit tests. Four exist to pin decisions that would otherwise erode: a conflict is not retryable, an absent `cause` is not `cause: undefined`, `wrap` survives a thrown non-Error, and `chain` terminates on a cycle |

### Runtime

| File | Description |
| --- | --- |
| `src/shared/env/index.ts` | **L1.** Typed configuration with no dependency. Components declare readers for what they own; nothing keeps a central list of every variable. Note: `notes/patterns/env.md` |
| `src/shared/env/source.ts` | Where values come from — a one-method port, so a test never mutates `process.env`. It is also the seam `secrets` wraps: `../ARCHITECTURE.md` §8 resolves `file://` and `env://` references **before** parsing, and `env` never learns it happened |
| `src/shared/env/readers.ts` | `text` · `integer` · `flag` · `oneOf` · `url` · `duration` · `sensitive` · `optional`. Refuses `8080abc` rather than truncating it, and `FEATURE=treu` rather than reading it as false. `sensitive` returns a `Secret` and has no fallback, because a default credential is useless or dangerous |
| `src/shared/env/load.ts` | Schema plus source to typed config — collecting **every** problem, so a broken deploy is fixed in one pass rather than one variable per restart. `explain` renders it for stderr, since the logger's own level comes from here and does not exist yet |
| `src/shared/env/index.test.ts` | 24 tests. The load-bearing one asserts four problems reported together; type-level assertions pin that the schema's literal unions, `Millis` and `Secret<string>` all survive inference |
| `src/shared/secrets/index.ts` | **L1.** Secret references resolved before configuration parses, per `../ARCHITECTURE.md` §8. Works by wrapping `env`'s `Source`, which is why that port exists — `env` never learns anything happened and no schema changes. Note: `notes/patterns/secrets.md` |
| `src/shared/secrets/reference.ts` | What a reference looks like: `file://` and `env://`, and nothing else. A value that merely contains `file://` is a literal, because a password may begin with almost anything. Carries the one escape `../MODULES.md` §2 requires — a `literal:` prefix is stripped and the remainder returned **verbatim**, so the reference syntax cannot make a password that genuinely begins `env://` unrepresentable. Not trimmed, unlike a reference: a reference with surrounding whitespace is a typo, a password with a trailing space is a password |
| `src/shared/secrets/filesystem.ts` | The two filesystem calls this needs, injectable so a test never touches a disk. Reads are synchronous because configuration is parsed before the process does anything, and capped at 1 MiB because a secret is a credential, not a database |
| `src/shared/secrets/resolve.ts` | The resolver. A Kubernetes mount is a directory of one file per key, so the directory form is tried first — which is what makes `../INFRASTRUCTURE.md` §7.1's "no new code" true. Problems are collected rather than thrown, so a broken reference joins the rest of the configuration report |
| `src/shared/secrets/inspect.ts` | The check command's engine — `../MODULES.md` §2: *prints each reference, its source, and a will-it-boot exit code, without printing a value.* Replaces the restart loop, where a broken reference surfaces as a process exiting 78 with one line, then again with the next, one variable per restart against a deployment already down. Resolves **through** `resolving` rather than beside it, because a check with its own copy of the resolution path diagnoses a different program and agrees with boot until the moment it matters. Rendering lives here, not in the composition root, because the no-value guarantee is this module's to keep |
| `src/shared/secrets/index.test.ts` | 34 tests. Covers the k8s mount shape, `key=value` and JSON selection, a reference loop, that a failure message never carries the file's contents, the `literal:` escape in a chain as well as at the top, and that the check command prints no value while naming every broken reference at once |
| `src/shared/health/index.ts` | **L1.** Liveness and readiness, deliberately kept apart. Liveness runs **no checks** — if it touched the database, a database blip would restart every pod at once and a bad minute would become a bad hour (conformance 41). A failing `optional` check is **degraded, never down**, because failing readiness on a backlog hands traffic to the instances already behind on the same queue (conformance 42, `../INFRASTRUCTURE.md` §7.4). `drain()` refuses traffic while the process stays assembled. Note: `notes/patterns/health.md` |
| `src/shared/health/index.test.ts` | 20 tests. Pins that liveness runs nothing even when every dependency is down, that an optional failure still serves traffic, and that a hung check fails on a deadline rather than hanging the probe |
| `src/shared/telemetry/index.ts` | **L1.** Traces and metrics behind a port, with two adapters that need no dependency: `noopTelemetry` and `memoryTelemetry`. The OTel SDK is confined to this module — rule `S10`, and the worked example `../ENFORCEMENT.md` uses for it — because an SDK that spreads *becomes* the interface and replacing it stops being a decision anybody can make. Correlation is read from the ambient provenance and never written back: `logger` emits `trace_id` from the same `traceparent` without importing this module, so a log line does not depend on whether tracing was configured. `inSpan` ends a span whatever happens, and a failed one keeps the error's `Kind` — the same promotion `err_kind` makes in the log record. **Deferred with a trigger:** the `otlp` and `prometheus` exporters, and the Jaeger and Prometheus services in compose, land together with the first module worth tracing — `postgres` or `httpx` — because a service nothing tests against is dead weight (`../INFRASTRUCTURE.md` §3 rule 7) and a tracer with nothing to trace proves nothing. Selecting one today is reported as unwired rather than silently dropped. That is also when this repo takes its first runtime dependency. Note: `notes/patterns/telemetry.md` |
| `src/shared/telemetry/index.test.ts` | 18 tests. Pins that the noop still returns and still throws, that ambient correlation cannot be forged by a passed attribute, that a span survives a throw and keeps its `Kind`, and that `open()` catches a leaked span |
| `src/shared/lifecycle/index.ts` | **L1.** Ordered start, reverse-order stop, signals. Reverse order holds after a failed start too — what started is stopped, what never started is not, because a half-started process holds ports and locks nothing will release. A component that will not stop is abandoned on a deadline: a process that refuses to exit is `SIGKILL`ed and loses what the others were about to finish. Declares its own `Reporter` rather than importing `logger`, so the shutdown path depends sideways on nothing. Note: `notes/patterns/lifecycle.md` |
| `src/shared/lifecycle/index.test.ts` | 23 tests. Ordering, the unwind after a failed start, a hung component being abandoned while the rest still stop, and that `handleSignals` keeps the event loop alive — the bug that exits a process with code 13 before any signal arrives |
| `src/shared/logger/index.ts` | **L1.** Three implementations of one port — console, JSON, memory. The baseline has **no dependencies**: `consoleLogger` formats and colourises by hand. If a library ever earns its place it becomes a fourth implementation behind the same port and rule `S10` confines it here. `detectColour()` lives here until `env` lands, and nothing in the module calls it — the composition root does. Note: `notes/patterns/logger.md` |
| `src/shared/logger/logger.ts` | Level filtering, bound fields, ambient provenance and redaction — once, so the three sinks cannot disagree about what was logged. The one place in the repository that deliberately swallows an error: a closed pipe must not become an outage |
| `src/shared/logger/format.ts` | Console and JSON rendering, and nothing that can throw. `JSON.stringify` throws on a cycle, so it is wrapped; a log call becoming an exception while something else is already wrong is worse than a lossy line |
| `src/shared/logger/record.ts` | `Level`, `Fields`, `LogRecord` — in the shape `../MODULES.md` §2 specifies, with the field names normative because conformance case 54 checks them byte-identically across every blueprint. Separating the record from its rendering is what lets a test assert on fields rather than on a formatted string |
| `src/shared/logger/logger.contract.ts` | The one suite every adapter passes (rule `M1`). Asserts a **field set**, not bytes: console renders for a human and JSON for a collector, so they differ in format and never in fields. Four cases — plain, with an error, with full provenance, with none |
| `src/shared/logger/adapters.test.ts` | Runs that suite against all three adapters. 12 assertions that would pass happily as three near-identical suites and cannot as one |
| `src/shared/logger/index.test.ts` | 35 tests. Includes the regression for redaction dismantling errors, a sink that throws, and a value that cannot be serialized |
| `src/shared/provenance/index.ts` | **L1.** The module's only importable surface. Deliberately does not re-export `createProvenance`, the id shape predicates, or the testkit — rule `S2` makes reaching past this file a violation, which is how TypeScript gets the boundary Go gets from an unexported identifier |
| `src/shared/provenance/actor.ts` | Who is responsible: a closed four-value `Kind` with the vocabulary in the id path, so `system:reindex` changes no type and no canonical form. `onBehalfOf` is defined now and populated in phase 2 — adding it after the first signature would change every actor already signed |
| `src/shared/provenance/provenance.ts` | The record. Private fields and closed construction, because `PROVENANCE.md` §6 and §7 require custom marshaling anyway — which makes immutability free. `derive(causedBy?)` is the only way to get a child |
| `src/shared/provenance/origins.ts` | The five origins that mint, and the adoption boundary. `InboundHeaders` omits `requestId`, `actor` and `tenant` entirely, so §5's rule is enforced by the type rather than noticed in review |
| `src/shared/provenance/carrier.ts` | `AsyncLocalStorage`. `current()` never throws because a log line must never crash; `require()` raises `Internal` because a stamp point without provenance is a bug |
| `src/shared/provenance/ids.ts` | The normative id shapes — §5's charset and the W3C `traceparent` format. Internal: one definition, because divergence here is a spec violation rather than a style difference |
| `src/shared/provenance/actor.test.ts` | 17 tests. Pins the exact serialized bytes, including that `on_behalf_of` is omitted rather than `null`, and that a plain object cannot counterfeit an actor |
| `src/shared/provenance/provenance.test.ts` | 22 tests. Covers the conformance case `PROVENANCE.md` §10 says nothing currently covers — the same logical record canonicalizing to identical bytes with `causation_id` and `tenant` absent — plus a golden canonical string |
| `src/shared/provenance/origins.test.ts` | 16 tests. Seven hostile correlation ids are each dropped rather than failing the request, and `traceparent` is checked against its own W3C shape rather than a charset |
| `src/shared/provenance/carrier.test.ts` | 13 tests. Three concurrent requests with deliberately interleaved completion each see only their own provenance — if that leaked, every audit record would be suspect and only under load |
| `src/shared/provenance/provenance.testkit.ts` | The builder. Test tooling: rule `S3` keeps it out of shipping code and `tsconfig.build.json` keeps it out of `dist` |

### Substrate

| File | Description |
| --- | --- |
| `src/shared/postgres/index.ts` | **L2, and the layer's one exception.** Not a port with two implementations — it is what the real implementations are built on, and its memory counterpart does not exist because a memory repository does not use it. `M1` applies to the repositories above it, never here; there is **no fake pool**. Exports `DB` and `withinTx` and deliberately **not** `Transactor`, which is consumer-declared in `app/`: an application layer importing `postgres` to say "these writes are atomic" would have inverted nothing. Note: `notes/patterns/postgres.md` |
| `src/shared/postgres/db.ts` | `DB` — `query`, `queryRow`, `exec`, and **both a pool and a transaction satisfy it**. That dual satisfaction is what makes `withinTx` transparent, so a repository works identically inside a transaction and outside one with no second set of methods. Names SQL and parameters, never a query builder: a repository naming `Kysely` in its signature would have to change to swap it, which is `../MODULES.md` §3's test for the interface being in the wrong place |
| `src/shared/postgres/config.ts` | A **struct**, not an interface — nothing swaps it. The **DSN is a parameter**, which is structural rather than additive: a test appends `search_path=<schema>` to get its own, and a module reading the DSN internally would put every test on one schema. All three guardrails resolve here and ride on the DSN as libpq startup options, **merged** with whatever it already carries so `testx`'s `search_path` is not clobbered |
| `src/shared/postgres/pool.ts` | The concrete pool, and the transaction. Declares the `Transactor` **shape** for documentation and **deliberately does not re-export it** — it is consumer-declared in `app/`, and a use case importing `postgres` to say "these writes are atomic" has inverted nothing. What it does carry is `PoolSatisfiesTransactor`, a compile-time assertion: a consumer-declared interface cannot notice the provider drifting, so this breaks the build **in `postgres`** instead of later in a consumer holding a copy of the old shape. Both go through one `dbOver` so SQLSTATE translation cannot be forgotten in one of them. Holds two fixes found by the guardrail tests: a client that dies mid-transaction emits `error` on *itself*, and an unhandled one takes the process down; and a dying connection emits **twice**, so the first error is kept because the second is its own consequence |
| `src/shared/postgres/sqlstate.ts` | SQLSTATE → `Kind`, one of the four behaviours the storage suite pins. Deliberately not exhaustive: an unrecognised code is `Internal`, because a code nobody has considered is a bug in the query rather than something a caller can act on. `40001` and `40P01` are `Unavailable` rather than `Conflict` so `isRetryable` says yes — on the two failures that most want retrying |
| `src/shared/postgres/migrate.ts` | Forward-only, checksummed, namespaced per context, applied under a transaction-scoped advisory lock so N instances deploying together serialise rather than race. **Takes a pool and a set**, so a test can migrate into its own schema. Exempt from `statement_timeout` via `SET LOCAL` and **not** from `lock_timeout`: a migration may take as long as it needs, and must not hold the deploy open blocking live traffic |
| `src/shared/postgres/storage.contract.ts` | The storage-behaviour suite — **not** the repository contract suite. Asserts the substrate behaves the same regardless of how the SQL was produced: NULL ordering, SQLSTATE → `Kind`, isolation default and implicit transactions, timestamp round-trip. Run with one adapter because the properties are worth pinning when nothing is being compared, and written before the first repository exists, which is the only cheap moment |
| `src/shared/postgres/index.test.ts` | 17 tests, no database. The SQLSTATE table, the guardrail defaults, and that the DSN merge preserves an existing `options` — the case that would otherwise put every test on the default schema while appearing to give it one of its own |
| `tests/testx/postgres.ts` | The integration-test harness. **Not a peer module** (`../MODULES.md` §3), so it lives under `tests/` where `S3` needs no arguing and it never ships. Schema per test, which is what the DSN-as-parameter rule buys: each caller gets a fresh schema and a pool pointed at it, so suites run in parallel against one database. Adding a second service — Redis with `cache`, SMTP with `mailer` — is a file beside this one, not a redesign |
| `src/shared/events/index.ts` | **L2.** A port with **swappable providers**; the outbox is one provider, not the module. `EVENTS_PROVIDER=memory\|outbox`, exactly as `STORAGE=memory\|postgres`. The two providers **do not make the same promise** and that is not a defect in the port — `eventstest` asserts what they share and the note carries the difference. Note: `notes/patterns/events.md` |
| `src/shared/events/event.ts` | `<context>.<entity>.<verb>`, lowercase, exactly three segments — two is ambiguous about which half is the context and four invites a hierarchy nothing consumes. Payloads are **primitives only**: a payload crosses a process boundary, outlives the request in an audit record, and is read by code compiled against a different version, where a `Date` serializes three ways and a class instance serializes to `{}` |
| `src/shared/events/envelope.ts` | Where rule `M5` lives. `Envelope.seal` takes `Provenance` as a **required parameter**, because `M5`'s detect clause is *publish goes through the envelope constructor, which requires them* — checkable, where *"hopefully the context had it"* is not. Also `provenanceFor(env)`, the subscriber rule in one line: correlation from the envelope, causation from the **event id**, a fresh request id. It lives here rather than in `provenance` because `provenance` is L1 and `S1` forbids it importing an envelope, permanently |
| `src/shared/events/ports.ts` | `Publisher` · `Subscriber` · `Dispatcher`. `publish` takes the caller's `DB`, which is the whole point of the outbox and which the memory bus ignores — honest rather than sloppy, since it has nothing to make atomic. `Handler` allows a synchronous subscriber: appending to a projection should not have to wear `async` to satisfy a port |
| `src/shared/events/memory.ts` | The in-process bus, and **not a testing convenience** — it is what makes invariant `I1` possible, because an outbox needs Postgres and `make dev` needs nothing. Dedupes in-process because the contract requires dedupe of *every* provider; that record is lost on restart, which is consistent with the rest of its promise and is exactly the durability gap the outbox closes |
| `src/shared/events/outbox/index.ts` | The durable provider. Writes the event row **inside the caller's transaction**, so publishing is atomic with the data write. The relay claims with `for update skip locked` so N relays never coordinate and never wait, backs off with full jitter, and **dead-letters rather than drops** — an event nobody can handle is still evidence that it happened. Claim and dispatch are separate transactions, so an arbitrary handler never runs inside the database's idle-in-transaction budget |
| `src/shared/events/outbox/schema.ts` | The tables, namespaced `events`. **Two clocks, deliberately apart**: `next_attempt_at` is backoff, `lease_until` is ownership, and collapsing them is the bug that makes a slow consumer look like a dead one. The claimable index is **not** partial — the obvious predicate uses `now()`, which PostgreSQL refuses in an index predicate because it is `STABLE` rather than `IMMUTABLE` (`42P17`), caught the first time this ran against a real database |
| `src/shared/events/eventstest.ts` | One contract suite, **14 cases, run twice** — separate tests prove both providers work, one suite run twice proves they **agree**, and only the second is what `M1` asks for. Covers fan-out to every matching subscriber and to none, at-least-once via a **deliberate** redelivery, **dedupe not suppressing a legitimate retry**, containment of both a rejected promise and a thrown non-Error, the constructor refusing to publish without provenance (`M5`), and a subscriber **deriving** rather than minting (case 38). Deliberately does **not** assert durability across process death, because one provider does not have it |
| `src/shared/events/index.test.ts` | 20 tests. Event-name shape, primitives-only payloads, the `M5` constructor refusing to build without provenance, `fromWire` refusing bytes it cannot read, and the whole contract suite against the memory provider |
| `tests/integration/events/outbox.test.ts` | 20 tests. The same 14-case contract suite against the outbox — a **real** PostgreSQL through `testx`, per-test schema and real migrations, because the outbox's central claim is that the row is written in the caller's transaction and that is only testable against Postgres. Plus what only it has: a rollback taking the event with it, leasing so a second relay skips the row, backoff and ownership in separate columns, dead-lettering, and the dedupe row keyed per subscriber |
| `tests/rules/fixtures/semantic/m6-event-names-wrong-context/src/contexts/identity/domain/events.ts` | Trips `M6` — `identity` publishing under the `orgs` prefix. The rule lands with **no contexts in the repo**, which is the phase-0 principle: the rule arrives before the code it governs, so it never needs an allowlist |
| `src/shared/lock/index.ts` | **L2.** A named distributed mutex behind a port. Advisory locks are the adapter for one property above all: **a crashed holder releases automatically**, because the lock lives on the connection. No sweeper, no TTL that is a guess about how long a healthy holder pauses, and no window in which a dead instance still owns the fleet's singleton. Note: `notes/patterns/lock.md` |
| `src/shared/lock/port.ts` | `tryAcquire` · `withLock` · `releaseAll`. **Never waits** — a lock that queues turns a contended period into a pile of instances each holding a connection open, which is how a fleet-wide singleton becomes a fleet-wide outage. The instance that lost should do nothing and try again next period |
| `src/shared/lock/key.ts` | An advisory key is a **signed 64-bit integer**, so every name is hashed to one — and that space is shared across the whole database, where a collision blocks with no error and no log line. `int64(first 8 bytes of sha256(namespace + ":" + name))`, documented because it must not be re-derived by guesswork, and namespaced so `jobs:purge` and `leases:purge` cannot collide |
| `src/shared/lock/memory.ts` | The `STORAGE=memory` adapter. Correct within one process and **structurally unable** to demonstrate the survives-holder-death property, because there is no other process to lose. Not a defect — `STORAGE=memory` is one process by definition (`I1`) — but the reason the contract suite stops where it does |
| `src/shared/lock/postgres.ts` | **Session-scoped** `pg_try_advisory_lock`, not the transaction-scoped variant the migrator uses: a job running for a minute would otherwise lose its lock at the first commit. Every lease holds **its own connection** for its whole life, since releasing from a different pooled connection is a silent no-op. That requirement is why `postgres` grew `Session` — naming a `PoolClient` here would have meant importing `pg`, which `S10` forbids, and the rule pushed the concept into the right module |
| `src/shared/lock/locktest.ts` | One contract suite, both adapters. Mutual exclusion, hand-over on release, non-reentrancy, `withLock` releasing when the work throws, and `releaseAll`. **Deliberately does not assert survives-holder-death** — the memory adapter cannot express it, and a suite that "proved" crash-safety against an in-process `Set` would give exactly the confidence that must not be given |
| `src/shared/lock/index.test.ts` | 14 tests. The key derivation staying inside the signed 64-bit range, being stable (changing it would split a rolling deploy so old and new instances take *different* locks and both run), separating namespaces — plus the whole contract against memory |
| `src/shared/jobs/index.ts` | **L2.** Periodic maintenance: a declared job with an `area.verb` name, a period with jitter, a timeout and a singleton flag, run by a scheduler that supplies minted provenance, failure containment, a span and uniform logging from a returned count. Note: `notes/patterns/jobs.md` |
| `src/shared/jobs/job.ts` | The declaration, validated at registration — which is boot rather than 3am. `singleton` **defaults to `false` explicitly**: a cache sweep is local and every instance should do its own, and an implicit default is how a destructive job runs N times because nobody wrote the flag |
| `src/shared/jobs/scheduler.ts` | Provenance is **minted, never derived** — a job is the root of its own chain (`../PROVENANCE.md` §4, the mint row), and getting it wrong is quiet: the job runs, the records are written, and nothing joins to anything. Overlap is **refused rather than queued**, because an overlapping purge is two workers deleting the same rows and waiting turns one slow run into a queue that fires at once when it clears. Jitter spreads the fleet; the singleton lock makes the outcome correct either way |
| `src/shared/jobs/index.test.ts` | 15 tests. The mint row asserted field by field, containment of a throwing job, the timeout signalling rather than claiming the work stopped, overlap being skipped, and `list`/`runNow` — the operator door that exists because whoever cannot invoke a purge on demand will invoke it with SQL instead |
| `tests/integration/lock/postgres.test.ts` | 12 tests. The shared contract against a real database, plus the property only this adapter has: a lock **released when its holding backend is terminated**, verified by finding the holder in `pg_locks` and calling `pg_terminate_backend`. Also that twenty refused acquires do not leak twenty connections |
| `tests/integration/jobs/singleton.test.ts` | **The closing condition for both modules.** Two schedulers, concurrent, against one real database, and the job body executed **once** — the claim that lets this architecture deploy as one Deployment with N replicas and no separate cron process. Verified failable by making the flag a no-op. Plus: the lock released when the job throws, non-singletons running everywhere by design, and `stop()` freeing the fleet lock so a rolling deploy does not strand it |
| `src/shared/mailer/index.ts` | **L2.** `send(message) -> Receipt` behind a port with three adapters — `memory`, `smtp`, `none` — and one contract suite all three pass. Knows nothing about users, tokens or challenges: the decision to send belongs to a context, and to an **event subscriber rather than a command's transaction**, because a slow SMTP server must not hold a transaction open and a rolled-back registration must not already have sent a welcome email. Note: `notes/patterns/mailer.md` |
| `src/shared/mailer/message.ts` | **The security-relevant part.** SMTP headers are CRLF-separated, so a control character in a display name or subject does not corrupt a header — it adds one: a silent `Bcc`, a forged `From`. Every header-bound field is **rejected**, never sanitised, because a stripped newline turns an attack into an odd display name nobody investigates. The error names the field and never echoes the value, since a rejected header ends up in a log |
| `src/shared/mailer/port.ts` | `send` and nothing else. Deliberately inconvenient to call mid-write — no `send(userId, template)` convenience and no transaction parameter — so the temptation does not arise when `identity` lands |
| `src/shared/mailer/templates.ts` | `<name>[.<lang>].{subject,txt,html}`, **compiled at boot** so a malformed placeholder fails startup rather than the first password reset at 3am. Locale fallback is **per part**: a missing `de.html` falls back to the default while a present `de.subject` is still used — falling back whole-template is how a German user gets an entirely English email because the HTML was unfinished. HTML auto-escapes every interpolated value; text and subject do not |
| `src/shared/mailer/memory.ts` | **Not a test double** — it is what lets `STORAGE=memory` finish `identity`'s verification flow with no Docker, the same role the memory event bus plays for `I1`. Logs the link at debug so it is retrievable from a terminal; debug rather than info because a link at info is a token in a production log aggregator. Also holds `noopMailer`, which drops and **still validates** |
| `src/shared/mailer/smtp.ts` | `nodemailer`, confined here by `S10`. Maps failures to a `Kind` that says whether retrying could help — 4xx and a refused connection are `Unavailable`, 5xx is `Invalid`, a socket timeout is `Timeout` — which is the distinction that lets `retry` and `breaker` work rather than treating every mail outage as permanent. Names the host and status, **never the credential** |
| `src/shared/mailer/mailertest.ts` | One contract suite, all three adapters. The receipt shape, retrievability of both rendered parts, every problem reported at once — and **five cases on header injection**, including that the `none` adapter validates too |
| `src/shared/mailer/index.test.ts` | 30 tests. Template compilation failing at boot, per-part locale fallback, HTML auto-escaping while text does not, the debug link, and the contract against `memory` and `none` |
| `tests/testx/mailpit.ts` | Mailpit for the harness — **a file beside `postgres.ts`, not a redesign**, which is what `../MODULES.md` §3 asks as substrate lands. Reads messages back through Mailpit's HTTP API, in two calls because the list endpoint carries headers only and asserting on a summary would prove the subject arrived and nothing else |
| `tests/integration/mailer/smtp.test.ts` | 15 tests against a real Mailpit. The shared contract, plus what only a real server shows: both parts actually arriving, no `Bcc` on the wire, an unreachable host mapping to `Unavailable`, and the password absent from the error. Includes the case that closes the security loop — the injected message reached **nobody**, which a sanitising implementation would fail while passing every rejection case |
| `src/shared/httpclient/index.ts` | **L2, and the last of the layer.** The outbound mirror of `httpx`: a **per-attempt** timeout (a 30s budget spent as three 10s attempts is a different thing from one 30s attempt), retries of only what is safe to replay, `Retry-After` honoured over local backoff, provenance on the wire with the **actor opt-in**, status → `Kind` with the upstream body never in the message, and bodies capped. Note: `notes/patterns/httpclient.md` |
| `src/shared/httpclient/policy.ts` | The two decisions that look obvious until they are wrong in production. **Replay safety**: the idempotent methods, or any request carrying an `Idempotency-Key` — a bare `POST` is never retried, because replaying a charge because a response was slow is worse than failing it. **What counts against the circuit**: only unreachable-or-5xx, since a 4xx means the endpoint is *up and rejecting you* and opening on it removes a working dependency because somebody typed a bad id |
| `src/shared/httpclient/client.ts` | `breaker`'s **first real caller** — per host, never global. An open circuit fails immediately **without consuming a retry**, which needed the `details.circuit` marker added to `breaker`, since its rejection is `Unavailable` and a retry loop would otherwise burn every attempt against a circuit refusing precisely to stop the traffic. Bodies are read through a capped stream because `Content-Length` is a claim, not a limit |
| `src/shared/httpclient/index.test.ts` | 28 tests against a **real local server**, not a mocked `fetch` — a stub asserts what the code asked for, a server asserts what went on the wire. Covers the per-attempt timeout firing three times, a POST not retried and a PUT retried, `Retry-After` beating local backoff, correlation and `traceparent` present while the actor is absent unless opted in, an oversized body capped rather than read, and the breaker opening, admitting **exactly one probe**, and closing on its success |
| `src/shared/classification/index.ts` | **L3, and first of the layer — the ordering is the point.** A sensitivity vocabulary and nothing else: no encryption, no masking, no policy. It says a field is PII; `fieldcrypt` decides encryption, `redact` decides printing, `retention` decides deletion, `exports` decides visibility. Built before its six consumers because otherwise there are six answers to *is an email address PII?*, and the specific failure is the export path disagreeing with the log path. Note: `notes/patterns/classification.md` |
| `src/shared/classification/level.ts` | Five levels, **closed** like `errors.Kind` and for the same reason — a level reaches canonical bytes and generated catalogs, so growing the set is a canonical-form change. **Ordered**, so a consumer asks *at or above `pii`* rather than enumerating and a later level does not silently narrow existing checks. `UNCLASSIFIED` is `regulated`: an unlabelled field is **not public**, because guessing low means data leaves the building looking compliant and only guessing high is recoverable |
| `src/shared/classification/registry.ts` | **Declaration, never inference** — a guesser that sees `email` and infers PII also sees `email_template_id` and errs in the direction that leaks. `classify<T>` takes a `Record<keyof T, Level>`, so adding a field and forgetting to classify it **does not compile**; that is `M9` enforced by the type system. Decorators were the alternative and `erasableSyntaxOnly` forbids them, which is the better constraint — a decorator is opt-in per field, an exhaustive record is opt-out |
| `src/shared/classification/redaction.ts` | **The layering, resolved rather than moved.** `redact` is L0 and this is L3, so `redact` cannot import it and moving `redact` up would drag `logger` with it. *Redaction is a mechanism; classification is a vocabulary* — so the vocabulary is supplied here and handed down as data. Normalises field names because `redact` matches a normalised key against a raw fragment, which had `displayName` in the sensitive list and printing in full |
| `src/shared/classification/index.test.ts` | 19 tests. The ordering, the closed set round-tripping through JSON and `digest`, declaration never inferring, an unclassified field being at or above **every** threshold, and the retrofit redacting a field `redact` alone would have printed |
| `tests/rules/fixtures/semantic/m9-classification-assertion/src/contexts/identity/domain/classification.ts` | Trips `M9` — an `as` assertion defeating the exhaustive record, which is what the type system cannot catch and what silently reintroduces an unlabelled field. Landed with **no contexts in the repository**, so the rule checks an empty set today |
| `tests/testx/probe.ts` | Is there a database to integrate against? Short connect timeout on purpose — the case being measured is the one where nothing answers, and that is the case that must not cost anybody a minute. Reports `host:port/database` and never the credentials, since the reason gets pasted into a report |
| `tests/testx/global-setup.ts` | Runs the probe **once per run**, in the main process, and hands the answer to every worker through `provide`. The first version probed at module scope in the gate, which meant once per *worker*: a connection attempt and a duplicate line for each one vitest span up, on the machine least able to afford it |
| `tests/testx/gate.ts` | Skip with a reason, never fail, when there is no database. Rung 0 is the rung that needs nothing (`../INFRASTRUCTURE.md` §1), and a suite that goes red on a fresh clone with no Docker is a suite people stop reading — after which a real failure in it is indistinguishable from the usual noise. The reason goes in the suite title, which the verbose reporter prints, **and** once on stderr, because the default reporter prints only a count and a skip whose cause is invisible reads as a pass |
| `tests/integration/postgres/storage.test.ts` | The storage suite against a real PostgreSQL. One adapter today; §3 nominates this repository for the two-adapters-under-one-repository-port experiment, and when the second lands this file gains a second call and nothing else |
| `tests/integration/postgres/migrate.test.ts` | Migrations against a real database — the half `postgres` is not ticked without. Idempotence, per-context namespacing, a refused edit to an applied migration, two migrators started together serialising on the advisory lock, and a failed set leaving the database exactly as it was |
| `tests/integration/postgres/guardrails.test.ts` | That the three timeouts actually **fire**, not merely that they are set — a setting applied to the wrong session, or after the first query, looks identical to one that works until the day it matters. Includes the asymmetry: a migration is exempt from the statement budget and not from the lock one. Found both pool defects listed above |
| `tests/integration/postgres/db.test.ts` | §3's acceptance test, by name: one repository whose signature names `DB`, handed **a pool, a transaction, and `testx`'s per-schema pool**, unchanged. There is no second version for the transactional case, and that absence is the assertion |

### Notes — language

Module notes are cited from each module's row above. These are not tied to a
module: `../TEMPLATE-CLAUDE.md` §5.2 gives `notes/language/` to *syntax, idioms,
standard library, type-system tricks*, and in a repository whose thesis is that
**the language is the only variable**, that is the category the comparison
actually turns on.

| File | Description |
| --- | --- |
| `notes/language/type-system.md` | Where the type system does architectural work: branded types for nominal typing in a structural language, closed enums without `enum`, a type and a value under one name, compile-time assertions (the `Transactor` drift check), and `#private` as a security control rather than a style — `private` is erased and reachable, `#` is not |
| `notes/language/strictness.md` | Four `tsconfig` flags beyond `strict` and the code each one forced. `exactOptionalPropertyTypes` is the interesting one: the `...(x === undefined ? {} : { x })` spread it demands **is** the collection's omit-absent-never-null wire rule, so the compiler enforces cross-language parity for free |
| `notes/language/stringification.md` | The four independent paths from a value to text, depended on in opposite directions: `redact` must close all four or a secret leaks through the one that was missed, and `digest` gets RFC 8785 almost free because the RFC defers to ECMAScript for numbers, string escaping and key order. `.sort()` is correct only because its default comparator is UTF-16 code units |
| `notes/language/numbers.md` | JavaScript has **one** number type plus `BigInt`, and no `int64` — the single largest place TypeScript and Go are genuinely not interchangeable. Where 2^53 is actually touched here: advisory lock keys (`BigInt` end to end), Postgres `bigint` arriving as a **string** on purpose, and RFC 8785's `max_safe` vector being the last value all three languages agree on without ceremony. Also `Date` being milliseconds where `timestamptz` is microseconds — a difference to know rather than a bug to fix |
| `notes/language/runtime.md` | ESM and Node: `.js` specifiers on TypeScript imports, `AsyncLocalStorage` and the one place it is deliberately not used, the event loop not staying open for a signal handler (exit 13, twice), and why draining microtasks takes `setImmediate` rather than one `await` |
| `notes/language/tooling.md` | Two TypeScript compilers side by side and why neither half could be given up; pnpm's `.pnpm/<pkg>@<version>/` layout and how it made every `S10` rule inert for installed packages; vitest projects and `globalSetup` for anything decided once per run rather than once per worker |

### Rules

| File | Description |
| --- | --- |
| `tests/rules/encoding.test.ts` | Every source file is **text, not data**. Not a numbered rule — `../ENFORCEMENT.md` has no id for it — but it earned a permanent test: `src/shared/digest/index.test.ts` held a raw `0x00`, `0x0f` and `0x1f`, which TypeScript parses and vitest runs happily while `file(1)` reports `data` and **grep skips the file entirely**. The cross-language fixture wiring inside it was therefore invisible to every text tool for four rounds of being told it was missing. No suite here could have caught it, because the suite is what was passing |
| `tests/rules/arch.test.ts` | Proves every rule in `.dependency-cruiser.cjs` actually fires. On an empty repo the cruise passes vacuously, and a rule that has never fired is a rule nobody has tested — so each one also gets a tree built to trip it. Three tests carry the weight: a clean tree reports nothing, each fixture trips exactly one named rule, and no rule ships without a fixture |
| `tests/smoke/main.test.ts` | The in-process composition smoke test — the file rule `S9` exempts by name. A unit test proves a module works; this proves the graph can be built at all. Runs at rung 0: no Docker, no network, no build |
| `tests/rules/semantic-rules.ts` | Rules about what the code does rather than what it imports, so they parse the syntax tree with ts-morph rather than the import graph. `M2`: no module reads `Date.now`, `performance.now` or zero-argument `new Date()` — `new Date('2026-01-01…')` is allowed, because naming an instant is not reading one. `I5`: only `random` touches entropy. `M13`: `breaker`, `ratelimit`, `retry`, `deadline` and `timers` measure durations on the monotonic reading, never on `now()`. **`I5` is named for the invariant, not for an `M` number** — `../ENFORCEMENT.md` covers the clock half of I5 and not the randomness half, and minting a local rule id would put this repo's rule set out of step with its siblings. It renames if the collection gives it one |
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
