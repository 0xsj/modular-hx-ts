import { describe, expect, it } from 'vitest';
import { fakeClock, millis, seconds, systemClock } from '../clock/index.js';
import { unavailable } from '../errors/index.js';
import {
  type Exchange,
  type Handler,
  type Reporter,
  type Request,
  type Response,
  json,
} from '../edge/index.js';
import { chain } from '../httpx/index.js';
import { fakeIds } from '../id/index.js';
import {
  idempotency,
  memoryRecords,
  KEY_HEADER,
  REPLAY_HEADER,
} from '../idempotency/index.js';
import { Actor, makeOrigins } from '../provenance/index.js';
import { unwrap } from '../result/index.js';
import { memoryTelemetry } from '../telemetry/index.js';
import { bucketContract } from './ratelimittest.js';
import {
  type Buckets,
  type Limit,
  callerKey,
  forwardedFor,
  memoryBucketStore,
  memoryBuckets,
  rateLimitHeaders,
  ratelimit,
  refilled,
  retryAfter,
} from './index.js';

const LIMIT: Limit = { limit: 5, window: seconds(10) };

describe('memory adapter', () => {
  const clock = fakeClock();
  // **One store, handed to every limiter the suite asks for.** A factory that
  // built a private map per call would pass `two limiters over one store`
  // without sharing anything, which is the exact defect the case exists for.
  const store = memoryBucketStore();

  bucketContract(() => ({
    name: 'memory',
    buckets: () => memoryBuckets(store, clock),
    // A fake clock, so a wide window costs nothing and the arithmetic is
    // exercised at a scale a real wait could never afford.
    window: seconds(10),
    advance: (duration) => clock.advance(duration),
  }));
});

// --- the arithmetic --------------------------------------------------------

describe('refill is monotonic — rule M13', () => {
  it('does not refill when the clock steps BACKWARD', () => {
    // Negative elapsed would *drain* the bucket, turning a clock correction
    // into a throttle nobody configured.
    expect(refilled(2, millis(-5_000), LIMIT)).toBe(2);
  });

  it('grants at most one full bucket when the clock steps FORWARD', () => {
    // A year of elapsed time is still five tokens. The cap is the token
    // bucket's own bound, which is what keeps a clock jump from being a burst
    // of unbounded size.
    expect(refilled(0, millis(365 * 24 * 3_600_000), LIMIT)).toBe(5);
  });

  it('reads the MONOTONIC clock, so a wall-clock jump moves nothing', async () => {
    // **The test the collection asks for by name.** `breaker` was bitten twice
    // by this shape. `setWallClock` moves the wall reading and leaves the
    // monotonic one alone — which is what an NTP correction actually is.
    const clock = fakeClock();
    const buckets = memoryBuckets(memoryBucketStore(), clock);

    for (let i = 0; i < 5; i++) await buckets.take('victim', LIMIT);

    // A year forward on the wall clock. No time has passed.
    clock.setWallClock(new Date('2027-01-01T00:00:00.000Z'));
    expect((await buckets.take('victim', LIMIT)).allowed).toBe(false);

    // And a year backward does not stall the bucket either: real elapsed time
    // is what refills it.
    clock.setWallClock(new Date('2025-01-01T00:00:00.000Z'));
    await clock.advance(seconds(10));

    expect((await buckets.take('victim', LIMIT)).allowed).toBe(true);
  });
});

describe('headers', () => {
  it('carries the three case 39 names', () => {
    const headers = rateLimitHeaders({
      allowed: true,
      limit: 5,
      remaining: 3,
      resetAfter: millis(0),
    });

    expect(headers).toEqual({
      'ratelimit-limit': '5',
      'ratelimit-remaining': '3',
      'ratelimit-reset': '0',
    });
  });

  it('makes Retry-After agree with Reset, from one value', () => {
    // Two numbers that are supposed to match and are computed separately
    // eventually stop matching, and a client burned by that once ignores both.
    const decision = {
      allowed: false,
      limit: 5,
      remaining: 0,
      resetAfter: millis(1_800),
    };

    expect(retryAfter(decision)).toBe(
      rateLimitHeaders(decision)['ratelimit-reset'],
    );
  });

  it('never tells a refused client to retry immediately', () => {
    // `Retry-After: 0` is an instruction to hammer.
    expect(
      retryAfter({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetAfter: millis(1),
      }),
    ).toBe('1');
  });

  it('rounds a reset up, so a client never wakes one millisecond early', () => {
    expect(
      rateLimitHeaders({
        allowed: false,
        limit: 5,
        remaining: 0,
        resetAfter: millis(1_001),
      })['ratelimit-reset'],
    ).toBe('2');
  });
});

// --- the caller key --------------------------------------------------------

const ALICE = unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844'));

function provenanceFor(actor = ALICE) {
  const p = makeOrigins(fakeIds(fakeClock())).forRequest();
  return actor.kind === 'anonymous' ? p : p.withActor(actor);
}

describe('the caller is the principal', () => {
  it('keys on the authenticated actor', () => {
    // Case 40, and the reason position 7 sits below authn: a limiter that ran
    // first would have no caller to key on.
    expect(callerKey(provenanceFor(), '203.0.113.7', {})).toBe(
      'principal:user:01a024c7-d2d6-7e71-8c87-e344e27ef844',
    );
  });

  it('falls back to the transport peer when nobody is identified', () => {
    expect(callerKey(provenanceFor(Actor.anonymous()), '203.0.113.7', {})).toBe(
      'peer:203.0.113.7',
    );
  });

  it('prefixes by kind, so an address cannot collide with an actor id', () => {
    const asActor = callerKey(provenanceFor(), '203.0.113.7', {});
    const asPeer = callerKey(
      provenanceFor(Actor.anonymous()),
      '203.0.113.7',
      {},
    );

    expect(asActor.startsWith('principal:')).toBe(true);
    expect(asPeer.startsWith('peer:')).toBe(true);
  });
});

describe('the trusted-proxy question', () => {
  const headers = { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' };

  it('IGNORES a forwarded-for header by default', () => {
    // **The default a deployment that has not thought about it gets.**
    // Trusting the header unconditionally hands every caller a limit-evasion
    // primitive: a new address per request is a new bucket.
    expect(
      callerKey(provenanceFor(Actor.anonymous()), '10.0.0.1', headers),
    ).toBe('peer:10.0.0.1');
  });

  it('reads from the RIGHT once a proxy is configured', () => {
    // With one proxy in front, the last entry is the address that proxy
    // observed. Everything to its left is whatever the caller chose to send.
    expect(forwardedFor(headers, { trustedProxyHops: 1 })).toBe('203.0.113.7');
  });

  it('does not let a caller forge a victim`s address', () => {
    // **The worse half of trusting it.** Forging the leftmost entry is a
    // limit-evasion trick; forging it as *somebody else's* address exhausts
    // their bucket, which turns a throttle into a tool aimed at one victim.
    const forged = {
      'x-forwarded-for': '<victim>, 203.0.113.7',
    };

    expect(forwardedFor(forged, { trustedProxyHops: 1 })).toBe('203.0.113.7');
    expect(forwardedFor(forged, { trustedProxyHops: 1 })).not.toContain(
      'victim',
    );
  });

  it('takes nothing when the chain is shorter than the topology claims', () => {
    // The request did not arrive through the proxies this deployment
    // describes, so nothing in the header is attributable. The peer still is.
    expect(forwardedFor(headers, { trustedProxyHops: 5 })).toBeUndefined();
  });

  it('ignores an empty or malformed header rather than keying on nothing', () => {
    expect(
      forwardedFor({ 'x-forwarded-for': '' }, { trustedProxyHops: 1 }),
    ).toBe(undefined);
    expect(
      forwardedFor({ 'x-forwarded-for': '  ,  ' }, { trustedProxyHops: 1 }),
    ).toBeUndefined();
  });
});

// --- the middleware, through the real chain --------------------------------

const clock = systemClock();

interface Wiring {
  readonly buckets?: Buckets;
  readonly limit?: Limit;
  readonly replicas?: number;
  readonly reporter?: Reporter;
  readonly anonymous?: boolean;
  readonly withIdempotency?: boolean;
}

function callable(handler: Handler, wiring: Wiring = {}) {
  const buckets =
    wiring.buckets ?? memoryBuckets(memoryBucketStore(), fakeClock());

  const built = chain(
    {
      clock,
      origins: makeOrigins(fakeIds(clock)),
      telemetry: memoryTelemetry(clock),
      ...(wiring.reporter === undefined ? {} : { reporter: wiring.reporter }),
      authenticate: (exchange) => {
        if (wiring.anonymous !== true) {
          exchange.provenance = exchange.provenance.withActor(ALICE);
        }
      },
      // **The whole wiring.** The slot was named and empty; this is one line.
      ratelimit: ratelimit({
        buckets,
        clock,
        limit: wiring.limit ?? LIMIT,
        ...(wiring.replicas === undefined ? {} : { replicas: wiring.replicas }),
        ...(wiring.reporter === undefined ? {} : { reporter: wiring.reporter }),
      }),
      ...(wiring.withIdempotency === true
        ? {
            idempotency: idempotency({
              records: memoryRecords(clock),
              anonymousCallers: 'refused',
            }),
          }
        : {}),
    },
    handler,
  );

  return (over: Partial<Request> = {}): Promise<Response> => {
    const request: Request = {
      method: 'POST',
      path: '/things',
      query: {},
      headers: {},
      peer: '203.0.113.7',
      body: () => Promise.resolve('{}'),
      ...over,
    };
    return built({
      request,
      responseHeaders: {},
      remaining: () => millis(30_000),
    } as Exchange);
  };
}

const ok: Handler = () => Promise.resolve(json(200, { ok: true }));

describe('conformance case 39', () => {
  it('answers 429 with RateLimit-* and Retry-After', async () => {
    const call = callable(ok);

    for (let i = 0; i < 5; i++) await call();
    const refused = await call();

    expect(refused.status).toBe(429);
    expect(refused.headers['ratelimit-limit']).toBe('5');
    expect(refused.headers['ratelimit-remaining']).toBe('0');
    expect(refused.headers['ratelimit-reset']).toBeDefined();
    expect(refused.headers['retry-after']).toBe(
      refused.headers['ratelimit-reset'],
    );
  });

  it('carries the headers on a 200 as well', async () => {
    // A client that learns its budget only by exceeding it has to exceed it to
    // learn anything, which rewards exactly the behaviour being limited.
    const response = await callable(ok)();

    expect(response.status).toBe(200);
    expect(response.headers['ratelimit-remaining']).toBe('4');
    expect(response.headers['retry-after']).toBeUndefined();
  });

  it('carries them on an error from further down the chain too', async () => {
    // The headers are parked on the exchange, so they survive whatever
    // position 10 does.
    const response = await callable(() => {
      throw new TypeError('boom');
    })();

    expect(response.status).toBe(500);
    expect(response.headers['ratelimit-limit']).toBe('5');
  });
});

describe('the 429 goes through the same mapper as every other error', () => {
  it('is an RFC 9457 problem body, not a special case', async () => {
    // **Position 7 sits below position 3 precisely so this is true.** A
    // limiter that built its own 429 would be a second place that renders an
    // error body, which is what the chain's shape exists to prevent.
    const call = callable(ok);

    for (let i = 0; i < 5; i++) await call();
    const refused = await call();

    expect(refused.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(refused.body)).toMatchObject({
      type: '/problems/exhausted',
      status: 429,
    });
  });

  it('still carries the request id', async () => {
    const call = callable(ok);

    for (let i = 0; i < 5; i++) await call();
    const refused = await call();

    expect(refused.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(refused.headers['x-correlation-id']).toBeDefined();
  });

  it('records err_kind on the access line', async () => {
    const lines: Record<string, unknown>[] = [];
    const call = callable(ok, {
      reporter: {
        info: (_m, fields) => lines.push(fields ?? {}),
        error: () => undefined,
      },
    });

    for (let i = 0; i < 6; i++) await call();

    expect(lines[5]?.['err_kind']).toBe('exhausted');
    expect(lines[5]?.['status']).toBe(429);
  });
});

describe('per caller, never global — case 40', () => {
  it('does not let one caller spend another`s budget', async () => {
    const store = memoryBucketStore();
    const buckets = memoryBuckets(store, fakeClock());

    const alice = callable(ok, { buckets });
    const anonymous = callable(ok, { buckets, anonymous: true });

    for (let i = 0; i < 5; i++) await alice();

    // Alice is exhausted; an anonymous caller from the same address is not.
    expect((await alice()).status).toBe(429);
    expect((await anonymous()).status).toBe(200);
  });

  it('does not hand an anonymous caller a fresh bucket per forged address', async () => {
    // **The end-to-end version of the trusted-proxy default.** Untrusted, a
    // caller that rotates `X-Forwarded-For` is still one bucket; trusted by
    // accident, it has as many buckets as it cares to invent.
    const buckets = memoryBuckets(memoryBucketStore(), fakeClock());
    const call = callable(ok, { buckets, anonymous: true });

    for (let i = 0; i < 5; i++) {
      await call({ headers: { 'x-forwarded-for': `198.51.100.${String(i)}` } });
    }

    const refused = await call({
      headers: { 'x-forwarded-for': '198.51.100.99' },
    });

    expect(refused.status).toBe(429);
  });

  it('separates two anonymous callers by peer address', async () => {
    const buckets = memoryBuckets(memoryBucketStore(), fakeClock());
    const call = callable(ok, { buckets, anonymous: true });

    for (let i = 0; i < 5; i++) await call({ peer: '203.0.113.7' });

    expect((await call({ peer: '203.0.113.7' })).status).toBe(429);
    expect((await call({ peer: '198.51.100.9' })).status).toBe(200);
  });
});

describe('failing open means degrading, not switching off', () => {
  const broken: Buckets = {
    take: () => Promise.reject(unavailable('connection refused')),
    purge: () => Promise.resolve(0),
  };

  it('keeps serving when the store is unreachable', async () => {
    // `RESILIENCE.md` §1: availability beats a broken throttle, and the edge is
    // still behind a load balancer.
    const response = await callable(ok, { buckets: broken })();

    expect(response.status).toBe(200);
  });

  it('still LIMITS, at one replica`s share', async () => {
    // **The half that is easy to lose.** "The store is unreachable" and "there
    // is no limit" are different facts, and a store outage is exactly when an
    // unlimited edge is most dangerous — whatever took the store down is
    // usually load, and removing the limiter adds more of it.
    const call = callable(ok, {
      buckets: broken,
      limit: { limit: 12, window: seconds(10) },
      replicas: 4,
    });

    let admitted = 0;
    for (let i = 0; i < 8; i++) {
      if ((await call()).status === 200) admitted += 1;
    }

    // 12 across 4 replicas is 3 here, not 12 and not unlimited.
    expect(admitted).toBe(3);
  });

  it('accumulates in one fallback bucket rather than a fresh one per request', async () => {
    // A fallback rebuilt per request is a full bucket per request, which is no
    // limit at all wearing a limit's shape.
    const call = callable(ok, { buckets: broken, limit: LIMIT, replicas: 1 });

    for (let i = 0; i < 5; i++) await call();

    expect((await call()).status).toBe(429);
  });

  it('says so, because I9 requires a fail-open choice to be logged', async () => {
    const lines: string[] = [];
    const call = callable(ok, {
      buckets: broken,
      reporter: { info: () => undefined, error: (m) => lines.push(m) },
    });

    await call();
    await call();

    // Once, not once per request: an outage should not become a log flood.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('limiting per process');
  });

  it('self-heals, and says that too', async () => {
    let failing = true;
    const flaky: Buckets = {
      take: (key, limit) =>
        failing
          ? Promise.reject(unavailable('connection refused'))
          : memoryBuckets(memoryBucketStore(), fakeClock()).take(key, limit),
      purge: () => Promise.resolve(0),
    };

    const info: string[] = [];
    const call = callable(ok, {
      buckets: flaky,
      reporter: { info: (m) => info.push(m), error: () => undefined },
    });

    await call();
    failing = false;
    await call();

    expect(info.join(' ')).toContain('recovered');
  });
});

describe('what is never limited', () => {
  it('leaves liveness and readiness alone', async () => {
    // Throttling the endpoint an orchestrator polls turns a traffic spike into
    // a rolling restart — the limiter causing the outage it was installed to
    // prevent.
    const buckets = memoryBuckets(memoryBucketStore(), fakeClock());
    const call = callable(ok, {
      buckets,
      limit: { limit: 1, window: seconds(10) },
    });

    for (let i = 0; i < 10; i++) {
      expect((await call({ path: '/healthz', method: 'GET' })).status).toBe(
        200,
      );
      expect((await call({ path: '/readyz', method: 'GET' })).status).toBe(200);
    }
  });

  it('does not spend budget on them either', async () => {
    // Exempt means *not counted*, not *counted and forgiven*: a readiness poll
    // every second would otherwise drain a caller's bucket without ever being
    // refused itself.
    const buckets = memoryBuckets(memoryBucketStore(), fakeClock());
    const call = callable(ok, {
      buckets,
      limit: { limit: 2, window: seconds(10) },
    });

    for (let i = 0; i < 10; i++) await call({ path: '/healthz' });

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });
});

describe('position 7 sits outside position 9', () => {
  it('spends budget on a REPLAYED idempotent request', async () => {
    // A replay is still a request against this edge. Position 9 answers it
    // without reaching the handler, and position 7 has already counted it —
    // otherwise a client with one key and a retry loop is unlimited.
    const buckets = memoryBuckets(memoryBucketStore(), fakeClock());
    const call = callable(ok, {
      buckets,
      withIdempotency: true,
      limit: { limit: 3, window: seconds(10) },
    });

    const headers = { [KEY_HEADER]: 'k1' };

    const first = await call({ headers });
    const second = await call({ headers });
    const third = await call({ headers });
    const fourth = await call({ headers });

    expect(second.headers[REPLAY_HEADER]).toBe('true');
    expect(first.headers['ratelimit-remaining']).toBe('2');
    expect(second.headers['ratelimit-remaining']).toBe('1');
    expect(third.headers['ratelimit-remaining']).toBe('0');
    // The fourth replay is refused by the limiter, not served by the store.
    expect(fourth.status).toBe(429);
  });
});
