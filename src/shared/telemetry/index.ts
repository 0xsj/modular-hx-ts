/**
 * Traces and metrics, behind a port. **L1 runtime.**
 *
 * `../../../MODULES.md`: *OTel traces + metrics; **SDK confined to this
 * module***. That confinement is rule `S10`, and OpenTelemetry is the example
 * `../../../ENFORCEMENT.md` uses for it — *the SDK belongs to `telemetry`; the
 * API is free.*
 *
 * The reason is not tidiness. An SDK that spreads becomes the interface: every
 * module that imports it inherits its lifecycle, its versioning, and its
 * opinion about context propagation, and replacing it stops being a decision
 * anyone can make. Behind a port it is one adapter among several, and the two
 * that ship here — doing nothing, and recording in memory — need no dependency
 * at all.
 *
 * **Spans are correlated from provenance, not the other way round.**
 * `../../../PROVENANCE.md` §3 names `telemetry` as one of three consumers that
 * may read the ambient provenance; §7 keeps `traceparent` a plain string so
 * `logger` can emit `trace_id` without importing this module. Telemetry reads;
 * it never becomes the source.
 *
 * See `notes/patterns/telemetry.md`.
 */

import { invariant } from '../assert/index.js';
import { type Clock, millis, type Millis, since } from '../clock/index.js';
import { isAppError, kindOf } from '../errors/index.js';
import { Carrier } from '../provenance/index.js';

/**
 * What may be attached to a span or a measurement.
 *
 * Primitives only, matching what every backend can actually index. An object
 * would be flattened by one exporter, stringified by another, and dropped by a
 * third.
 */
export type Attributes = Readonly<Record<string, string | number | boolean>>;

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  /** Mark the span failed, and record why. */
  recordError(error: unknown): void;
  /** Idempotent: ending twice is a bug, not a second span. */
  end(): void;
}

export interface Tracer {
  /** Begin a span. The caller is responsible for ending it. */
  start(name: string, attributes?: Attributes): Span;

  /**
   * Run something inside a span, ending it whatever happens.
   *
   * The form that should be used almost everywhere: a span left unended by an
   * early return or a throw is worse than no span, because it never arrives and
   * the trace it belonged to looks truncated.
   */
  inSpan<T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    attributes?: Attributes,
  ): Promise<T>;
}

export interface Counter {
  add(delta: number, attributes?: Attributes): void;
}

export interface Histogram {
  record(value: number, attributes?: Attributes): void;
}

export interface Gauge {
  set(value: number, attributes?: Attributes): void;
}

export interface Meter {
  /** Monotonic. Requests served, events published, retries attempted. */
  counter(name: string): Counter;
  /** A distribution. Latency, payload size, batch length. */
  histogram(name: string): Histogram;
  /** A level that moves both ways. Queue depth, open connections. */
  gauge(name: string): Gauge;
}

export interface Telemetry {
  readonly tracer: Tracer;
  readonly meter: Meter;
}

// --- doing nothing ---------------------------------------------------------

const NOOP_SPAN: Span = {
  setAttribute: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

/**
 * Telemetry that costs nothing.
 *
 * The default, and what `TELEMETRY_TRACES=none` selects. A blueprint must run
 * with zero external dependencies (invariant I1), so the absence of a collector
 * cannot be a failure — and instrumented code must not have to ask whether
 * telemetry is configured.
 */
export function noopTelemetry(): Telemetry {
  const counter: Counter = { add: () => undefined };
  const histogram: Histogram = { record: () => undefined };
  const gauge: Gauge = { set: () => undefined };

  return {
    tracer: {
      start: () => NOOP_SPAN,
      inSpan: async (_name, fn) => fn(NOOP_SPAN),
    },
    meter: {
      counter: () => counter,
      histogram: () => histogram,
      gauge: () => gauge,
    },
  };
}

// --- recording in memory ---------------------------------------------------

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Attributes;
  readonly took: Millis;
  readonly failed: boolean;
  readonly error?: string;
  readonly errorKind?: string;
}

export interface Measurement {
  readonly name: string;
  readonly kind: 'counter' | 'histogram' | 'gauge';
  readonly value: number;
  readonly attributes: Attributes;
}

export interface MemoryTelemetry extends Telemetry {
  spans(): readonly RecordedSpan[];
  measurements(): readonly Measurement[];
  /** Spans begun and not yet ended — a leak detector. */
  open(): number;
  clear(): void;
}

/**
 * Telemetry a test can assert on.
 *
 * The equivalent of `memoryLogger`: a test states what should have been
 * measured rather than whether a collector received it, so instrumentation is
 * testable without any infrastructure at all.
 */
export function memoryTelemetry(clock: Clock): MemoryTelemetry {
  const spans: RecordedSpan[] = [];
  const measurements: Measurement[] = [];
  let openSpans = 0;

  const record = (
    kind: Measurement['kind'],
    name: string,
    value: number,
    attributes: Attributes = {},
  ): void => {
    measurements.push({ name, kind, value, attributes });
  };

  const start = (name: string, attributes: Attributes = {}): Span => {
    invariant(name !== '', 'a span is named');
    const startedAt = clock.elapsed();
    openSpans += 1;

    // Correlation comes from provenance, so a span and a log line written in
    // the same breath carry the same ids without either module knowing about
    // the other.
    const provenance = Carrier.current();
    const attrs: Record<string, string | number | boolean> = {
      ...attributes,
      ...(provenance === undefined
        ? {}
        : {
            request_id: provenance.requestId,
            correlation_id: provenance.correlationId,
            actor: String(provenance.actor),
          }),
    };

    let ended = false;
    let failed = false;
    let error: string | undefined;
    let errorKind: string | undefined;

    return {
      setAttribute: (key, value) => {
        attrs[key] = value;
      },

      recordError: (thrown) => {
        failed = true;
        error = thrown instanceof Error ? thrown.message : String(thrown);
        errorKind = isAppError(thrown) ? kindOf(thrown) : undefined;
      },

      end: () => {
        // Ending twice would double-count the duration and, in a real
        // exporter, emit the same span identity twice.
        if (ended) return;
        ended = true;
        openSpans -= 1;

        spans.push({
          name,
          attributes: attrs,
          took: millis(Math.round(since(clock, startedAt))),
          failed,
          ...(error === undefined ? {} : { error }),
          ...(errorKind === undefined ? {} : { errorKind }),
        });
      },
    };
  };

  return {
    tracer: {
      start,
      inSpan: async (name, fn, attributes) => {
        const span = start(name, attributes);
        try {
          return await fn(span);
        } catch (thrown) {
          span.recordError(thrown);
          throw thrown;
        } finally {
          span.end();
        }
      },
    },

    meter: {
      counter: (name) => ({
        add: (delta, attributes) => {
          record('counter', name, delta, attributes);
        },
      }),
      histogram: (name) => ({
        record: (value, attributes) => {
          record('histogram', name, value, attributes);
        },
      }),
      gauge: (name) => ({
        set: (value, attributes) => {
          record('gauge', name, value, attributes);
        },
      }),
    },

    spans: () => spans,
    measurements: () => measurements,
    open: () => openSpans,
    clear: () => {
      spans.length = 0;
      measurements.length = 0;
    },
  };
}
