---
module: env
layer: L1
---

# Env

## What

Typed configuration from a `Source`. A component declares readers for the
variables it owns — `text`, `integer`, `flag`, `oneOf`, `url`, `duration`,
`sensitive` — and `load` turns a schema plus a source into a typed object, or
into a single error naming **every** problem.

`explain` renders that error for a startup failure. `describe` lists what is set
without saying what any of it is.

## Why

### All problems at once

`../MODULES.md` requires it and the reason is the person on the other end. A
loader that stops at the first bad variable produces: deploy, fail, fix, deploy,
fail, fix — one cycle per mistake, each costing whatever a deploy costs in that
environment. A misconfigured service should say everything that is wrong the
first time:

```
3 configuration problems
  PORT        is not a whole number: 80a0
  LOG_LEVEL   is not one of trace, debug, info, warn, error: shout
  LOG_FORMAT  is not one of console, json: xml
```

Collecting rather than throwing is why readers return a value describing what
went wrong instead of raising. The failure is one `Invalid` error whose `fields`
carry one entry per variable — the same shape [[errors]] already uses for a
rejected request body, so configuration and input report identically.

### Components declare their own schema

Nothing here owns a list of every variable in the system. A module contributes
the readers for what it owns, and the composition root assembles them. A central
registry would have to be edited by every module that ever needs a value, which
is how it ends up stale, and how a variable outlives the code that read it.

### No dependency

Every environment value is a string that needs coercion, sometimes a default,
sometimes a `Secret`. That is a small and specific job, and the part that
matters is the **message**, not the parsing — `is not one of memory, postgres:
mysql` beats anything generic, because the next thing anyone does after reading
an error is look for what would have been valid.

`CLAUDE.md` puts zod at the HTTP boundary, where input is JSON and shapes are
arbitrary. This is a different boundary with one shape.

### Secrets self-redact

`../ARCHITECTURE.md` §8. `sensitive()` returns a [[redact]] `Secret`, so a
credential is `[redacted]` through every path to text — including a
configuration dump, a log line, and an error about a *different* variable.

## Example

```ts
// A component declares what it needs.
const SCHEMA = {
  storage: oneOf('STORAGE', ['memory', 'postgres'], { fallback: 'memory' }),
  port: integer('PORT', { fallback: 15430, min: 1, max: 65535 }),
  timeout: duration('SHUTDOWN_TIMEOUT', { fallback: seconds(15) }),
  password: sensitive('SMTP_PASSWORD'),
  databaseUrl: optional(url('DATABASE_URL')),
} as const;

// The composition root loads it, and stops if it cannot.
const config = load(fromProcess(), SCHEMA);
if (isErr(config)) {
  process.stderr.write(`${explain(config.error)}\n`);
  return 78; // EX_CONFIG
}

// Fully typed, including the literal union and the Secret.
config.value.storage;  // 'memory' | 'postgres'
config.value.password; // Secret<string>
```

## Gotchas

- **A blank value is an unset value.** `PORT=` in a compose file is the same
  statement as omitting the line, and a reader that treated `''` as present
  would report `is not a whole number:` with nothing after the colon.
- **`optional` and `fallback` are different statements.** A fallback says "use
  this when unset"; optional says "this feature is off". They produce different
  types — `T` and `T | undefined` — and conflating them is how a missing
  `DATABASE_URL` becomes a connection to the wrong default.
- **`8080abc` is refused, not truncated.** A value that is *nearly* a number is
  a typo, and quietly reading `8080` from it is how a service listens on a port
  nobody chose.
- **`FEATURE=treu` is refused, not false.** A flag that silently reads as off is
  worse than a startup failure that names the variable.
- **`sensitive` has no fallback, deliberately.** A default credential is either
  useless or dangerous, and both are worse than being told it is missing.
- **Configuration is read before there is a logger.** The logger's own level and
  format come from here, so a configuration failure has to be plain text on
  stderr. That is not a limitation to route around; it is why `explain` exists.
- **`version` deliberately needs no configuration.** The moment somebody asks
  what is deployed is usually the moment the configuration is broken.
- **Secret references are resolved *before* parsing**, by wrapping the `Source`
  — `secrets` supplies that, and nothing in this module changes. That is the
  whole reason `Source` is a port rather than a direct `process.env` read.

## Used in

- `src/shared/env/index.ts`
- `src/shared/env/source.ts`
- `src/shared/env/readers.ts`
- `src/shared/env/load.ts`
- `src/main.ts`

This list grows to every module with something to configure.

## Related

[[redact]] — `sensitive()` returns a `Secret`. [[errors]] — the failure is one
`Invalid` carrying every problem in `fields`. [[clock]] — `duration()` returns
`Millis`, so a value read as seconds cannot be passed where milliseconds are
expected. [[logger]] — configured by this, and therefore not available to
report its failure. [[buildinfo]] — read through the same `Source`, but
deliberately outside the schema, because it fails open.
