---
module: telemetry
layer: L1
---

# Telemetry

## What

Traces and metrics behind a port. Two implementations ship with no dependency at
all: `noopTelemetry()`, which does nothing, and `memoryTelemetry(clock)`, which
records spans and measurements for a test to assert on.

```
Tracer  start(name, attributes) -> Span    Span  setAttribute / recordError / end
        inSpan(name, fn, attributes)
Meter   counter / histogram / gauge
```

`TELEMETRY_TRACES` and `TELEMETRY_METRICS` select the adapter. `none` is the
default and the only one wired today; `otlp` and `prometheus` name exporters
that live behind this same port.

## Why

### The SDK is confined here, and that is a rule

`../MODULES.md` says *SDK confined to this module*; `../ENFORCEMENT.md` uses
OpenTelemetry as the worked example of rule `S10` — **the SDK belongs to
`telemetry`; the API is free.** `layers.cjs` carries the table, dependency-
cruiser enforces it, and a fixture under
`tests/rules/fixtures/arch/s10-vendor-telemetry` trips it on purpose.

The reason is not tidiness. An SDK that spreads *becomes* the interface: every
module importing it inherits its lifecycle, its versioning and its opinion about
context propagation, and replacing it stops being a decision anybody can make.
Behind a port it is one adapter among several — which is what makes the two
zero-dependency ones possible, and invariant I1 (`make dev` and `make test` need
nothing external) achievable at all.

### Correlation comes from provenance, one way only

`../PROVENANCE.md` §3 names `telemetry` as one of three consumers permitted to
read the ambient carrier, so a span picks up `request_id`, `correlation_id` and
`actor` without being handed them.

The direction matters. `logger` emits `trace_id` from `provenance.traceparent`
— a plain string, deliberately — and **never** from here. Both modules sit at
L1, so an import between them would be sideways for a value already in hand,
and it would make the log line depend on whether tracing happened to be
configured. Provenance is the source; both are readers.

### `inSpan` rather than `start`/`end`

A span left unended by an early return or a throw is worse than no span: it
never arrives, and the trace it belonged to looks truncated at exactly the point
somebody is investigating. `inSpan` ends it in a `finally` and records the
failure on the way past. `start` remains for the genuinely long-lived span that
outlives one function, and `open()` exists so a test can prove none leaked.

### A failed span keeps its `Kind`

The same promotion the log record makes with `err_kind`: a span that failed
carries the error's message and, when it is an `AppError`, its `Kind`. A trace
is then as queryable as a log line — *show me the `unavailable` spans* — and the
two views agree because they read the same vocabulary. Absent, never null, for
the same cross-language parity reason as everywhere else.

### Deferred: the OTLP and Prometheus exporters

Not built yet, and the placeholder says so out loud rather than dropping traces
silently. `docker-compose.yml` has no Jaeger or Prometheus for the same reason
`../INFRASTRUCTURE.md` §3 rule 7 gives: a service nothing tests against is dead
weight. Both land together — the adapter, the services, and the contract suite
that proves the adapter against them.

## Example

```ts
const telemetry = noopTelemetry();

await telemetry.tracer.inSpan('identity.purge', async (span) => {
  const purged = await purge();
  // The interesting attributes are only known once the work has run.
  span.setAttribute('rows', purged.length);
});

telemetry.meter.counter('requests').add(1, { route: '/readyz' });
telemetry.meter.histogram('latency_ms').record(12);
telemetry.meter.gauge('queue_depth').set(4);
```

And in a test:

```ts
const telemetry = memoryTelemetry(clock);

await Carrier.run(provenance, () => handle(request));

expect(telemetry.spans()[0]?.attributes).toMatchObject({
  correlation_id: provenance.correlationId,
});
expect(telemetry.open()).toBe(0);
```

## Gotchas

- **Attributes are primitives only.** An object would be flattened by one
  exporter, stringified by another and dropped by a third.
- **Ambient correlation wins over a passed attribute.** Otherwise an attribute
  bag could quietly relabel whose request a span belonged to.
- **`end()` is idempotent.** Ending twice would double the duration and, in a
  real exporter, emit the same span identity a second time.
- **Duration comes from `clock.elapsed()`**, per rule `M13` — a monotonic
  reading, not the wall clock, so an NTP step cannot produce a negative span.
  The clock is injected (`M2`), which is what lets a 90-second span be asserted
  instantly.
- **No provenance is not an error.** A migration or a boot-time job has none.
  The correlation attributes are then simply absent — not empty strings.
- **`span` was being redacted.** `redact` matched `pan` as a substring, and
  `span` contains it. Fragments of three characters or fewer now match a whole
  segment, so `card_pan` still redacts and `span`, `panel` and `expand` do not.
  Found by logging a span name through the real binary, which is the argument
  for wiring each module into `main.ts` as it lands.

## Used in

- `src/shared/telemetry/index.ts`
- `src/main.ts`

This list grows to `httpx`, `postgres`, `events` and `jobs` — every module with
work worth timing.

## Related

[[provenance]] — the source of correlation, read ambiently here and never
written. [[logger]] — the other reader; emits `trace_id` from the same
`traceparent` without importing this module. [[clock]] — injected, and what
makes span durations monotonic and testable. [[errors]] — a failed span keeps
its `Kind`, the same promotion `err_kind` makes in the log record. [[redact]] —
which was over-matching span names until this module found it.
