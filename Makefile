# modular-hx-ts — the interface to the verification ladder.
#
# Rung 0 (`dev`, `test`) requires NOTHING: no Docker, no daemon, no network.
# If a change makes rung 0 need infrastructure, the change is wrong.
# See ../INFRASTRUCTURE.md §1.
#
#   make dev                zero dependencies         STORAGE=memory, seeded
#   make curl               zero dependencies         the journey, as requests
#   make test               zero dependencies         unit + arch + docs rules
#   make db-up && migrate   postgres                  schema applies
#   make test-integration   postgres                  both adapters, one suite
#   make e2e                postgres + real binary    journeys over HTTP
#   make openapi            zero dependencies         regenerate docs/openapi.json
#   make ci                 zero dependencies         everything a push must pass

SHELL       := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help
.NOTPARALLEL:

PNPM         ?= pnpm
COMPOSE      ?= docker compose
COMPOSE_FILE ?= docker-compose.yml
PROJECT      ?= modular-hx-ts
DC           := $(COMPOSE) -p $(PROJECT) -f $(COMPOSE_FILE)

# Host ports come from ../PORTS.md, the authority — nothing else assigns one.
# This repo's base is 15420 and its block is 15420-15439; every service is
# base + a fixed offset, so the arithmetic IS the reservation and no port needs
# tracking. Postgres is +0. Container ports are never namespaced.
# Override per invocation: PG_PORT=25420 make db-up
PG_PORT     ?= 15420
PG_USER     ?= app
PG_PASSWORD ?= app
PG_DB       ?= app
# ../PORTS.md offsets +2 and +3 for this repository's 15420 base.
MAILPIT_SMTP_PORT ?= 15422
MAILPIT_UI_PORT   ?= 15423

DATABASE_URL ?= postgres://$(PG_USER):$(PG_PASSWORD)@localhost:$(PG_PORT)/$(PG_DB)?sslmode=disable

export PG_PORT PG_USER PG_PASSWORD PG_DB DATABASE_URL
export MAILPIT_SMTP_PORT MAILPIT_UI_PORT

.PHONY: help
help: ## List targets
	@awk 'BEGIN{FS=":.*?## "} \
	     /^## /{printf "\n\033[1m%s\033[0m\n", substr($$0,4); next} \
	     /^[a-zA-Z0-9_-]+:.*?## /{printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo

## Rung 0 — no infrastructure

.PHONY: install
install: ## Install dependencies from the lockfile
	$(PNPM) install --frozen-lockfile

# **The build stamp, from git, for anything run out of a working tree.**
#
# `buildinfo` fails open on a missing stamp and reports `unknown` — right for a
# container whose CI forgot, wrong for a `/version` that `CONFORMANCE.md` §3.9
# makes the evidence a report names its binary with. `unknown` identifies
# nothing, and identifying the process is the entire point of the endpoint.
STAMP = APP_COMMIT=$$(git rev-parse HEAD 2>/dev/null || echo unknown) \
        APP_VERSION=$$(git describe --tags --always --dirty 2>/dev/null || echo dev) \
        APP_DIRTY=$$(git diff --quiet 2>/dev/null && echo false || echo true)

.PHONY: dev
dev: ## Boot, seed and serve — zero external dependencies
	@# **Rung 0a.** `TRUSTED_PROXIES=none` is the legal explicit answer for a
	@# process with no proxy in front (../MODULES.md §5 forbids a default), and
	@# `SEED_ON_BOOT` fills this process with demo data. In memory mode `make
	@# seed` would be a *different* process and a different empty map, which is
	@# the trap this criterion exists to catch.
	@echo "→ http://127.0.0.1:$${PORT:-15430}  ·  in another terminal: make curl"
	$(STAMP) STORAGE=memory TRUSTED_PROXIES=none SEED_ON_BOOT=demo $(PNPM) run dev

.PHONY: curl
curl: ## Print the journey as runnable requests — generated, never written
	@# Read off the route table the server mounts, so a path that moves moves
	@# here on the next run and a route that does not exist cannot be printed.
	@$(PNPM) exec tsx tools/curl.ts

.PHONY: routes
routes: ## List every route this process serves — method, path, auth
	@$(PNPM) exec tsx tools/routes.ts

.PHONY: statuses
statuses: ## Which declared statuses were ever observed — make statuses LOG=serve.log
	@# Reports, never fails. `../ENFORCEMENT.md`: a declared status is a claim
	@# nothing checks, and the converse of S11 cannot be decided statically.
	@test -n "$(LOG)" || { echo "usage: make statuses LOG=<access log>" >&2; exit 2; }
	$(PNPM) exec tsx tools/statuses.ts $(LOG)

.PHONY: openapi
openapi: ## Regenerate docs/openapi.json from the route registry
	@$(PNPM) exec tsx tools/openapi.ts

.PHONY: openapi-check
openapi-check: ## Fail if the committed spec no longer matches the registry
	@# The third of `../MODULES.md`'s three words. A schema change that alters
	@# the published contract fails the build instead of shipping quietly —
	@# without this, `openapi` is decoration.
	@$(PNPM) exec tsx tools/openapi.ts --check

.PHONY: build
build: ## Compile to dist/
	@# Phase 0 lands the rules before the code they govern, so until the first
	@# module exists there is nothing to compile. Say so rather than failing.
	@if [ -z "$$(find src -name '*.ts' 2>/dev/null | head -1)" ]; then \
	  echo "build: no sources yet"; \
	else \
	  echo "$(PNPM) run build"; $(PNPM) run build; \
	fi

.PHONY: start
start: build ## Run the compiled output in memory mode
	STORAGE=memory $(PNPM) run start

.PHONY: test
test: arch ## Unit + composition smoke + docs rules (N, D, R) + semantic rules (M)
	$(PNPM) exec vitest run --project unit

.PHONY: arch
arch: ## S1 · S5–S10 — import boundaries, by parsing every import
	@roots=$$(for d in src tests; do [ -d "$$d" ] && printf '%s ' "$$d"; done); \
	if [ -z "$$roots" ]; then echo "arch: no source roots yet"; else \
	  echo "$(PNPM) exec depcruise --config .dependency-cruiser.cjs $$roots"; \
	  $(PNPM) exec depcruise --config .dependency-cruiser.cjs $$roots; \
	fi

.PHONY: lint
lint: arch ## ESLint, plus the structural rules
	$(PNPM) exec eslint .

.PHONY: typecheck
typecheck: ## tsc, no emit — TypeScript 7, the native compiler
	$(PNPM) run typecheck

.PHONY: fmt
fmt: ## Format in place
	$(PNPM) exec prettier --write .

.PHONY: fmt-check
fmt-check: ## Fail if anything is unformatted
	$(PNPM) exec prettier --check .

.PHONY: audit
audit: ## Known vulnerabilities in the dependency tree
	$(PNPM) audit --audit-level high

.PHONY: ci
ci: fmt-check lint typecheck test openapi-check build ## Everything a push must pass without infrastructure
	@echo "ci: green"

## Rungs 1–3 — real infrastructure

.PHONY: test-integration
test-integration: ## Contract suites a second time, against the real adapters
	@if [ -z "$$(find tests/integration -name '*.test.ts' 2>/dev/null | head -1)" ]; then \
	  echo "test-integration: no suites yet"; \
	else \
	  echo "$(PNPM) exec vitest run --project integration"; \
	  $(PNPM) exec vitest run --project integration; \
	fi

.PHONY: e2e
e2e: ## Journeys against the real binary
	@if [ -z "$$(find tests/e2e -name '*.test.ts' 2>/dev/null | head -1)" ]; then \
	  echo "e2e: no suites yet"; \
	else \
	  echo "$(PNPM) exec vitest run --project e2e"; \
	  $(PNPM) exec vitest run --project e2e; \
	fi

.PHONY: migrate
migrate: ## Apply migrations to $DATABASE_URL
	@if [ ! -f src/main.ts ]; then \
	  echo "migrate: no entry point yet"; \
	else \
	  echo "$(PNPM) run migrate"; $(PNPM) run migrate; \
	fi

## The local stack

.PHONY: infra-up
infra-up: ## Start every service and wait until each is healthy
	$(DC) up -d --wait

.PHONY: infra-down
infra-down: ## Stop every service, keeping volumes
	$(DC) down

.PHONY: infra-reset
infra-reset: ## Stop every service and DESTROY its data
	$(DC) down -v

.PHONY: db-up
db-up: ## Postgres only — the loop most work needs
	$(DC) up -d --wait postgres

.PHONY: db-down
db-down: ## Stop Postgres, keeping its data
	$(DC) stop postgres

.PHONY: db-reset
db-reset: ## Recreate Postgres and DESTROY its data
	@# No leading `-`: a reset that silently fails to drop the volume is worse
	@# than one that fails loudly. `-f` is for "already gone", not "in use".
	$(DC) rm -sf postgres
	docker volume rm -f $(PROJECT)_pgdata
	$(DC) up -d --wait postgres

.PHONY: mail-up
mail-up: ## Mailpit only — SMTP sink plus a web UI to read it
	$(DC) up -d --wait mailpit
	@echo "mailpit UI: http://localhost:$(MAILPIT_UI_PORT)"

.PHONY: mail-down
mail-down: ## Stop Mailpit, keeping the rest of the stack
	$(DC) stop mailpit

.PHONY: seed
seed: ## Bootstrap administrator + demo data (needs a database)
	@# `make dev` seeds itself; this is for a real database. The credentials are
	@# development ones and are printed on purpose — a starter kit nobody can
	@# log into is a starter kit nobody keeps.
	BOOTSTRAP_ADMIN_EMAIL=$${BOOTSTRAP_ADMIN_EMAIL:-admin@example.test} \
	BOOTSTRAP_ADMIN_PASSWORD=$${BOOTSTRAP_ADMIN_PASSWORD:-admin-password-1} \
	STORAGE=postgres $(PNPM) exec tsx src/main.ts seed --demo

.PHONY: psql
psql: ## Interactive psql against the local database
	$(DC) exec postgres psql -U $(PG_USER) -d $(PG_DB)

.PHONY: sql
sql: ## Run one statement: make sql SQL='select 1'
	@test -n "$(SQL)" || { echo "usage: make sql SQL='select 1'" >&2; exit 2; }
	@$(DC) exec -T postgres psql -U $(PG_USER) -d $(PG_DB) -c "$(SQL)"

.PHONY: logs
logs: ## Follow logs: make logs SERVICE=postgres
	$(DC) logs -f $(SERVICE)

## Housekeeping

.PHONY: clean
clean: ## Remove build output and tool caches
	rm -rf dist coverage node_modules/.vite *.tsbuildinfo
