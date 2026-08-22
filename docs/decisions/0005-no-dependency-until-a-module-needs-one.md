# ADR 0005 — A runtime dependency arrives with the module that needs it

**Status:** Accepted · **Date:** 2026-08-22

## Context

Invariant I1 requires `make dev` and `make test` to run the whole application
with **zero external dependencies** — no database, no broker, no collector.
That is about *services*. It says nothing about npm packages, and the two get
conflated.

The question came up first at `logger` and again at `telemetry`, and it will
come up at every L2 module. Both times the reflex answer was available and
reasonable: take the well-known library, wire it in, move on.

`dependencies` in `package.json` is currently `{}`. Twenty-six modules exist.
That is either a discipline or an accident, and it has not been written down as
either.

## Decision

**No runtime dependency is added until a module needs one, and it is added
inside that module.** `dependencies` stays empty until something genuinely
cannot be written here.

Three things follow, and they are the actual content of the decision:

1. **The baseline implementation carries no dependency.** `logger` formats and
   colourises by hand. `telemetry` ships a no-op and an in-memory recorder.
   `env` and `secrets` parse their own input. Each is a real implementation, not
   a placeholder.
2. **A library, when one earns its place, becomes another adapter behind the
   same port** — not a replacement for the port. If adopting it changes anything
   outside its module, the port was not worth having and that is worth learning.
3. **Rule `S10` confines it.** The vendor table in `layers.cjs` names the owning
   module, and the fixture suite trips it. An SDK that spreads *becomes* the
   interface: every module importing it inherits its lifecycle, its versioning
   and its opinions, and replacing it stops being a decision anyone can make.

The bar for adding one is that the alternative is *wrong*, not merely longer.
A protocol with a specification (OTLP), a wire format nobody should re-implement
(Postgres), a cryptographic primitive — those clear it. Formatting, parsing and
timing do not.

## Alternatives considered

- **`pino` for `logger`.** Viable, fast, and what most projects would pick.
  Rejected: the whole of what it provides here is level filtering, field
  merging and a JSON writer, all of which are behind the port anyway. Taking it
  would have made the first dependency a *convenience*, which sets the bar for
  every later one.
- **The OpenTelemetry SDK for `telemetry`, at the time the module landed.**
  Genuinely arguable — `../MODULES.md` says the SDK ships in phase 1. Rejected
  *for now* and recorded with a trigger in `docs/TREE.md`: there are no handlers
  and no queries yet, so an exporter would ship one span from `doctor`, and
  `../INFRASTRUCTURE.md` §3 rule 7 says a service nothing tests against is dead
  weight. The adapter, the compose services and its contract suite land
  together.
- **Take dependencies freely and rely on `S10` to confine them.** Rejected:
  `S10` bounds the blast radius of a dependency, it does not make an unnecessary
  one free. Supply-chain surface, install time and upgrade obligation are all
  paid whether or not the import is confined.
- **Vendor sources instead of depending.** Rejected: it converts a dependency
  with a version into one without, which is worse in every direction that
  matters.

## Consequences

- More code here, and it is code we own and must test. `logger`'s console
  formatter and `secrets`' file parsing are the visible price.
- **A blueprint someone can read end to end.** This is the return, and it is the
  reason the price is worth paying: a reader can follow every line from
  `main.ts` to the bytes without leaving the repository.
- The first dependency will be conspicuous, which is intended. `postgres` is the
  most likely — `pg` clears the bar without argument.
- A dependency added later cannot claim precedent from an earlier convenience,
  because there is no earlier convenience.
- Writing a formatter by hand found real defects a library would have hidden —
  the console-format parser failed twice, both times because the format itself
  had quietly stopped being machine-readable.

## Verification

`package.json`'s `dependencies` object. It is empty, and any addition is a
one-line diff in review that this ADR is the argument against.

Rule `S10` verifies the second half — that whatever does arrive stays inside its
module — with fixtures under `tests/rules/fixtures/arch/` for each entry in the
vendor table, including one for an OpenTelemetry SDK import from outside
`telemetry`.

There is **no test asserting `dependencies` stays empty**, deliberately: the
decision is that dependencies are justified, not that they are forbidden, and a
test would state the wrong rule.

## Enforced by

`S10` — vendor confinement, the half of this decision that is mechanical. The
rest is the review argument above.
