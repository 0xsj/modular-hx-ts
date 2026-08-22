---
module: logger
layer: L1
---

# Logger

## What

A structured logging port with three implementations, as `../MODULES.md`
specifies: **console** for a person, **JSON** for a machine, **memory** for a
test. Five levels, bound fields via `child()`, and every line carrying
provenance and passing through redaction.

The baseline has **no dependencies**. `consoleLogger` formats and colourises by
hand.

## The record shape is specified

`../MODULES.md` §2 fixes the field names. This is not a local choice, and it is
not style: five repositories built a logger and **none emitted the error's
`Kind`**, because nothing said to. That is a specification gap rather than five
oversights — the same shape as the `clock` surface, a v1 capability that did not
survive because it was never written down.

| Field | When | Value |
| --- | --- | --- |
| `time` · `level` · `msg` | always | — |
| `request_id` · `correlation_id` | provenance present | from provenance |
| `causation_id` · `tenant` | present and non-empty | **omitted when absent** |
| `actor` | provenance present | the `kind:id` display form |
| `on_behalf_of` | impersonating | same form |
| `trace_id` | traceparent present | derived from `provenance.traceparent` |
| `error` | an error is logged | its message |
| **`err_kind`** | an error is logged | **its `Kind`** |

### Why `err_kind` is the one that matters

`Kind` is the whole error taxonomy. A line carrying `err_kind=unavailable` is
**queryable** — count it, alert on it, group by it — in a way `msg="upstream
failed"` never is, because a message is prose and prose is only greppable.

It is also the natural join to the status the edge produced from the same value:
an alert on `err_kind=unavailable` and a 503 rate are the same question asked
twice, and without the field they cannot be reconciled.

The first `Error` among the fields is promoted, and **its own key is dropped** —
two names for one failure on one line is how a dashboard counts it twice. A
second error stays where it was put.

### `trace_id` comes from provenance, never from `telemetry`

That is exactly why `traceparent` is a plain string on provenance rather than a
typed span context: `logger` and `telemetry` are both L1, so reaching for the
tracer would be a sideways dependency for a value already in hand. Only the
trace id goes on the line — the header is `version-traceid-parentid-flags`, and
the rest correlates nothing.

### Absent fields are omitted

A line carries what is true, not a row of empty strings. Unlike the of-record
form this is ergonomic rather than correctness-critical, since log records are
not hashed — but the instinct is the same one.

## Why

### One port, three sinks, one path through the middle

Level filtering, bound fields, ambient provenance and redaction all happen in
one place, and the three implementations differ only in what becomes of a
finished `LogRecord`. That is what stops the console output and the JSON output
disagreeing about what was logged — a class of bug that is invisible in
development, because development only ever looks at one of them.

Separating the record from its rendering is also what lets a test assert on
**fields** rather than on a formatted string. A test that matches
`'INFO  user registered'` breaks when somebody adds a space; a test that asserts
`fields.email` does not.

### One suite, every adapter

Rule `M1` says a module with more than one implementation has **one** suite that
every implementation passes. Every repository read that as L2 — "the first
module with two adapters" — which is reasonable and too narrow. The test is not
whether implementations are interchangeable *backends*; it is whether they must
**agree observably**. Console renders for a human and JSON for a collector, so
they differ in **format** and never in **fields**.

`logger.contract.ts` therefore asserts a **field set**, not bytes, across four
cases: a plain message, a message with an error, a message with full
provenance, and a message with none. Each adapter supplies a way to recover what
it emitted — which for the console adapter means parsing its own output, and a
human format nobody can machine-read is one that has quietly stopped carrying
what it claims.

### No library, deliberately

A logging library brings transports, serializers, redaction, child loggers and
level management — most of which is either here already or belongs to another
module. What is left is formatting, which is a hundred lines.

If one ever earns its place, it becomes a fourth implementation behind this same
port and rule `S10` confines it to this module. Nothing else in the repository
would change, which is the test of whether the port was worth having.

### Provenance is pulled, not passed

`PROVENANCE.md` §3 names `logger` as one of exactly three consumers permitted to
read provenance ambiently. Threading it through every log call would be noise,
and this caller cannot forget. `current()` returns nothing when there is no
scope, which is why a log line outside a request still works.

Logs are the **observability** audience, so the actor is its compact
`user:01a0…` string rather than the nested of-record object. Anything hashed or
signed uses `toJSON`; a person reads a line.

### Redaction is not optional

Handing a whole request body or header map to a logger is how a bearer token
reaches disk. Every record's fields go through `redactKeys` before anything is
written. It costs a copy per line — real on a hot path, and the right trade
when the alternative is a credential in a log aggregator that four teams can
search.

## Example

```ts
// Composition root: one switch, and colour decided here rather than sniffed.
const log =
  config.logFormat === 'json'
    ? jsonLogger({ clock, level: config.logLevel })
    : consoleLogger({ clock, level: config.logLevel, colour: detectColour() });

// A component binds what it would otherwise repeat.
const worker = log.child({ queue: 'exports' });
worker.info('claimed', { batch: 3 });

// A test asserts on fields, not on formatting.
const log = memoryLogger({ clock: fakeClock() });
expect(log.records()[0]?.fields).toMatchObject({ queue: 'exports' });
```

## Gotchas

- **A log line never throws — and this is the one place in the repository that
  swallows an error.** The sink is wrapped, and the formatter cannot throw. A
  closed pipe or a full disk is an observability failure; letting it become an
  exception makes it an outage. Invariant I9: availability controls fail open.
- **[[redact]] used to destroy errors, and it took a real log line to notice.**
  `redactKeys` rebuilt every object from its enumerable properties, and
  `Error.message` and `.stack` are **not enumerable** — so an error field
  arrived as `{name, kind, fields, details}` with the message gone, and
  `instanceof Error` false. Errors now pass through untouched. A secret inside
  one belongs in a `Secret`, which redacts itself wherever it is printed.
- **Colour is a parameter, not an inspection.** Sniffing a TTY inside the
  formatter would make output depend on where the test ran. `detectColour()`
  exists for the composition root to call, and belongs to `env` when that lands.
- **The record's own keys win in JSON.** A field called `level`, `msg` or
  `time` would otherwise shadow the real one, so the record's three are written
  last.
- **Console values are quoted only when ambiguous.** `email=ada@example.com`
  reads better than the quoted form, and an unquoted value containing a space
  would silently look like two fields.
- **The console parser in the contract suite failed twice, instructively.**
  First the padded level (`INFO ` plus a separator) is already a double space,
  so scanning for one read the message as the field list. Then a quoted value
  containing spaces — `error="no user with that id"` — tore apart when split on
  spaces. Both are properties of the format, and both were invisible until
  something had to read it back.
- **`enabled(level)` exists for expensive fields.** `if (log.enabled('debug'))`
  before building something costly; the level check itself is already cheap.
- **A child shares its parent's sink and level**, including a memory logger's
  buffer — so a test sees everything a component logged however it subdivided
  its logger.
- **The timestamp comes from the injected clock**, per rule `M2`. That is also
  what makes a log assertion deterministic.

## Used in

- `src/shared/logger/index.ts`
- `src/shared/logger/logger.ts`
- `src/shared/logger/format.ts`
- `src/shared/logger/record.ts`
- `src/main.ts`

This list grows to every module and context that has something to say.

## Related

[[provenance]] — pulled ambiently, and the reason `current()` may not throw.
[[redact]] — every field goes through it, and the Error defect above.
[[clock]] — injected, per rule `M2`. [[errors]] — `kind` and the cause chain are
what a failure line is actually for.
