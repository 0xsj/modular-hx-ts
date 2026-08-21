# modular-hx-ts — the interface to the verification ladder.
#
# Rung 0 (`dev`, `test`) requires NOTHING: no Docker, no daemon, no network.
# If a change makes rung 0 need infrastructure, the change is wrong.
# See ../INFRASTRUCTURE.md §1.
#
#   make dev                zero dependencies         STORAGE=memory
#   make test               zero dependencies         unit + arch + docs rules
#   make db-up && migrate   postgres                  schema applies
#   make test-integration   postgres                  both adapters, one suite
#   make e2e                postgres + real binary    journeys over HTTP
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

DATABASE_URL ?= postgres://$(PG_USER):$(PG_PASSWORD)@localhost:$(PG_PORT)/$(PG_DB)?sslmode=disable

export PG_PORT PG_USER PG_PASSWORD PG_DB DATABASE_URL

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

.PHONY: dev
dev: ## Run the whole application with zero external dependencies
	STORAGE=memory $(PNPM) run dev

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
ci: fmt-check lint typecheck test build ## Everything a push must pass without infrastructure
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
