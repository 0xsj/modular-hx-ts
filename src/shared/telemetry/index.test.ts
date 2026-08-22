import { describe, expect, it } from 'vitest';
import { fakeClock, millis } from '../clock/index.js';
import { Kind, unavailable } from '../errors/index.js';
import { Actor, Carrier } from '../provenance/index.js';
import { fakeProvenance } from '../provenance/provenance.testkit.js';
import { unwrap } from '../result/index.js';
import { memoryTelemetry, noopTelemetry } from './index.js';

const USER = '01a024c7-d2d6-7e71-8c87-e344e27ef844';

describe('doing nothing', () => {
  it('still returns what the work returned', async () => {
    // Instrumented code must not have to ask whether telemetry is configured,
    // so the noop has to be a real implementation of the port, not a stub that
    // swallows the result.
    const telemetry = noopTelemetry();

    await expect(telemetry.tracer.inSpan('work', () => 42)).resolves.toBe(42);
  });

  it('still propagates what the work threw', async () => {
    const telemetry = noopTelemetry();

    await expect(
      telemetry.tracer.inSpan('work', () => {
        throw unavailable('down');
      }),
    ).rejects.toThrow('down');
  });

  it('accepts every instrument without a collector anywhere', () => {
    // Invariant I1: the blueprint runs with zero external dependencies, so the
    // absence of a collector cannot be a failure.
    const { meter, tracer } = noopTelemetry();

    expect(() => {
      meter.counter('requests').add(1, { route: '/healthz' });
      meter.histogram('latency').record(12);
      meter.gauge('connections').set(3);
      const span = tracer.start('work');
      span.setAttribute('key', 'value');
      span.recordError(new Error('boom'));
      span.end();
    }).not.toThrow();
  });
});

describe('a span', () => {
  it('records its name and attributes', async () => {
    const telemetry = memoryTelemetry(fakeClock());

    await telemetry.tracer.inSpan('purge', () => undefined, { rows: 12 });

    const [span] = telemetry.spans();
    expect(span?.name).toBe('purge');
    expect(span?.attributes).toMatchObject({ rows: 12 });
    expect(span?.failed).toBe(false);
  });

  it('takes its duration from the injected clock, not the wall clock', async () => {
    // Rule M13: a duration is measured from a monotonic reading. The clock is
    // injected (M2), which is what lets a 90-second span be asserted instantly.
    const clock = fakeClock();
    const telemetry = memoryTelemetry(clock);

    await telemetry.tracer.inSpan('slow', async () => {
      await clock.advance(millis(90_000));
    });

    expect(telemetry.spans()[0]?.took).toBe(90_000);
  });

  it('keeps attributes set after it began', async () => {
    // The interesting attributes — row counts, cache hits — are only known
    // once the work has run.
    const telemetry = memoryTelemetry(fakeClock());

    await telemetry.tracer.inSpan('query', (span) => {
      span.setAttribute('rows', 7);
    });

    expect(telemetry.spans()[0]?.attributes).toMatchObject({ rows: 7 });
  });

  it('ends once, however many times it is ended', () => {
    // Ending twice would double the duration and, in a real exporter, emit the
    // same span identity a second time.
    const telemetry = memoryTelemetry(fakeClock());

    const span = telemetry.tracer.start('work');
    span.end();
    span.end();

    expect(telemetry.spans()).toHaveLength(1);
    expect(telemetry.open()).toBe(0);
  });

  it('is refused without a name', () => {
    expect(() => memoryTelemetry(fakeClock()).tracer.start('')).toThrow();
  });
});

describe('a span around failing work', () => {
  it('ends anyway, and rethrows', async () => {
    // A span left unended by a throw is worse than no span: it never arrives,
    // and the trace it belonged to looks truncated.
    const telemetry = memoryTelemetry(fakeClock());

    await expect(
      telemetry.tracer.inSpan('purge', () => {
        throw unavailable('database is unreachable');
      }),
    ).rejects.toThrow('database is unreachable');

    expect(telemetry.open()).toBe(0);
    expect(telemetry.spans()).toHaveLength(1);
  });

  it('keeps the failure’s Kind, so a trace is as queryable as a log line', async () => {
    const telemetry = memoryTelemetry(fakeClock());

    await telemetry.tracer
      .inSpan('purge', () => {
        throw unavailable('database is unreachable');
      })
      .catch(() => undefined);

    const [span] = telemetry.spans();
    expect(span?.failed).toBe(true);
    expect(span?.error).toBe('database is unreachable');
    expect(span?.errorKind).toBe(Kind.Unavailable);
  });

  it('omits err_kind for something that is not an AppError', async () => {
    // Absent, never null — the same omit-absent rule the log record follows,
    // so a backend never has to distinguish "no kind" from "kind: null".
    const telemetry = memoryTelemetry(fakeClock());

    await telemetry.tracer
      .inSpan('work', () => {
        throw new TypeError('undefined is not a function');
      })
      .catch(() => undefined);

    const [span] = telemetry.spans();
    expect(span?.failed).toBe(true);
    expect(span?.error).toBe('undefined is not a function');
    expect(span).not.toHaveProperty('errorKind');
  });
});

describe('correlation', () => {
  it('comes from the ambient provenance', async () => {
    // PROVENANCE.md §3 names telemetry as one of three consumers that may read
    // ambient. A span and a log line written in the same breath then carry the
    // same ids without either module importing the other.
    const telemetry = memoryTelemetry(fakeClock());
    const provenance = fakeProvenance({
      requestId: 'req_abc',
      correlationId: 'corr_xyz',
      actor: unwrap(Actor.user(USER)),
    });

    await Carrier.run(provenance, () =>
      telemetry.tracer.inSpan('handle', () => undefined),
    );

    expect(telemetry.spans()[0]?.attributes).toMatchObject({
      request_id: 'req_abc',
      correlation_id: 'corr_xyz',
      actor: `user:${USER}`,
    });
  });

  it('is simply absent outside a request', async () => {
    // A job at startup has no provenance. That is not an error, and it must
    // not be an empty string either.
    const telemetry = memoryTelemetry(fakeClock());

    await telemetry.tracer.inSpan('migrate', () => undefined);

    expect(telemetry.spans()[0]?.attributes).not.toHaveProperty('request_id');
  });

  it('does not let a caller forge it', async () => {
    // Ambient wins. Otherwise an attribute bag could quietly relabel whose
    // request a span belonged to.
    const telemetry = memoryTelemetry(fakeClock());
    const provenance = fakeProvenance({ requestId: 'req_real' });

    await Carrier.run(provenance, () =>
      telemetry.tracer.inSpan('handle', () => undefined, {
        request_id: 'req_forged',
      }),
    );

    expect(telemetry.spans()[0]?.attributes).toMatchObject({
      request_id: 'req_real',
    });
  });
});

describe('a leaked span', () => {
  it('is visible, which is the point of counting open ones', () => {
    // `inSpan` exists so this cannot happen. `open()` is how a test proves it.
    const telemetry = memoryTelemetry(fakeClock());

    telemetry.tracer.start('forgotten');

    expect(telemetry.open()).toBe(1);
    expect(telemetry.spans()).toEqual([]);
  });
});

describe('metrics', () => {
  it('record their value, kind and attributes', () => {
    const telemetry = memoryTelemetry(fakeClock());

    telemetry.meter.counter('requests').add(1, { route: '/readyz' });
    telemetry.meter.histogram('latency_ms').record(12);
    telemetry.meter.gauge('connections').set(3);

    expect(telemetry.measurements()).toEqual([
      {
        name: 'requests',
        kind: 'counter',
        value: 1,
        attributes: { route: '/readyz' },
      },
      { name: 'latency_ms', kind: 'histogram', value: 12, attributes: {} },
      { name: 'connections', kind: 'gauge', value: 3, attributes: {} },
    ]);
  });

  it('accumulate under one name rather than replacing each other', () => {
    // Each `add` is a measurement. A counter that kept only the last value
    // would report one request per scrape however much traffic arrived.
    const telemetry = memoryTelemetry(fakeClock());
    const requests = telemetry.meter.counter('requests');

    requests.add(1);
    requests.add(1);
    requests.add(1);

    const total = telemetry
      .measurements()
      .filter((m) => m.name === 'requests')
      .reduce((sum, m) => sum + m.value, 0);
    expect(total).toBe(3);
  });

  it('let a gauge move both ways', () => {
    const telemetry = memoryTelemetry(fakeClock());
    const depth = telemetry.meter.gauge('queue_depth');

    depth.set(10);
    depth.set(2);

    expect(telemetry.measurements().at(-1)?.value).toBe(2);
  });
});
