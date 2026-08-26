/**
 * `httpclient`, against a **real local server**.
 *
 * Not a mock `fetch`. A stubbed client asserts what the code asked for; a
 * server asserts what actually went on the wire — which headers arrived, how
 * many requests were made, and whether a body that was never supposed to be
 * read was read anyway.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeBreaker } from '../breaker/index.js';
import { fakeClock, millis, seconds, systemClock } from '../clock/index.js';
import { Kind, kindOf } from '../errors/index.js';
import { Carrier, makeOrigins } from '../provenance/index.js';
import { fakeIds } from '../id/index.js';
import { fakeRandom } from '../random/index.js';
import { makeRetry } from '../retry/index.js';
import { isErr, unwrap } from '../result/index.js';
import { IDEMPOTENCY_KEY, kindForStatus, retryAfter } from './policy.js';
import { makeClient, type ClientOptions } from './client.js';

const clock = systemClock();

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
}

let server: Server;
let origin: string;
let requests: Recorded[] = [];

/** Set per test: what the next response should be. */
let handler: (req: IncomingMessage) => {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  delayMs?: number;
};

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
    });

    const reply = handler(req);
    const send = (): void => {
      res.writeHead(reply.status, reply.headers ?? {});
      res.end(reply.body ?? '');
    };
    if (reply.delayMs === undefined) send();
    else setTimeout(send, reply.delayMs);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  origin = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

beforeEach(() => {
  requests = [];
  handler = () => ({ status: 200, body: 'ok' });
});

function build(over: Partial<ClientOptions> = {}) {
  const random = fakeRandom();
  return makeClient({
    clock,
    // Zero backoff so a retry test is not a sleep test. The delay logic has its
    // own coverage in `retry`; what matters here is *whether* a retry happened.
    retry: makeRetry({ sleep: () => Promise.resolve() }, random),
    breaker: makeBreaker(clock),
    timeout: seconds(2),
    ...over,
  });
}

describe('status maps to Kind', () => {
  it('maps each class the way the edge will read it', () => {
    expect(kindForStatus(500)).toBe(Kind.Unavailable);
    expect(kindForStatus(503)).toBe(Kind.Unavailable);
    // Exhausted, not Unavailable: rate limiting is not an outage, and a
    // dashboard grouping by err_kind must be able to tell them apart.
    expect(kindForStatus(429)).toBe(Kind.RateLimited);
    expect(kindForStatus(401)).toBe(Kind.Unauthenticated);
    expect(kindForStatus(403)).toBe(Kind.Forbidden);
    expect(kindForStatus(404)).toBe(Kind.NotFound);
    expect(kindForStatus(408)).toBe(Kind.Timeout);
    expect(kindForStatus(422)).toBe(Kind.Invalid);
  });

  it('never puts the upstream body in the message', async () => {
    // The body is attacker-influenced on some paths and noise on all of them,
    // and it is how internal detail reaches a log line somebody screenshots.
    handler = () => ({
      status: 500,
      body: '<html>Traceback: /srv/app/secret.py line 42, token=sk_live_abc</html>',
    });

    const failure = await build().send({ method: 'GET', url: `${origin}/x` });

    expect(isErr(failure)).toBe(true);
    const printed = isErr(failure)
      ? `${failure.error.message}${JSON.stringify(failure.error.details)}`
      : '';
    expect(printed).not.toContain('sk_live_abc');
    expect(printed).not.toContain('Traceback');
    expect(printed).toContain('500');
    expect(printed).toContain('127.0.0.1');
  });
});

describe('retry only what is safe to retry', () => {
  it('does not retry a bare POST', async () => {
    // Replaying a charge because a response was slow is worse than failing it.
    handler = () => ({ status: 503 });

    await build().send({ method: 'POST', url: `${origin}/charge` });

    expect(requests).toHaveLength(1);
  });

  it('retries a PUT', async () => {
    handler = () => ({ status: 503 });

    await build({ attempts: 3 }).send({ method: 'PUT', url: `${origin}/x` });

    expect(requests).toHaveLength(3);
  });

  it('retries a GET', async () => {
    handler = () => ({ status: 503 });

    await build({ attempts: 2 }).send({ method: 'GET', url: `${origin}/x` });

    expect(requests).toHaveLength(2);
  });

  it('retries a POST carrying an Idempotency-Key', async () => {
    // The caller asserting the upstream will deduplicate it — which only the
    // caller can know.
    handler = () => ({ status: 503 });

    await build({ attempts: 3 }).send({
      method: 'POST',
      url: `${origin}/charge`,
      headers: { [IDEMPOTENCY_KEY]: 'key-1' },
    });

    expect(requests).toHaveLength(3);
  });

  it('does not retry a 4xx, however many attempts are allowed', async () => {
    // The request is wrong. Sending it again cannot make it right.
    handler = () => ({ status: 422 });

    await build({ attempts: 5 }).send({ method: 'GET', url: `${origin}/x` });

    expect(requests).toHaveLength(1);
  });

  it('does not retry a 403', async () => {
    handler = () => ({ status: 403 });

    await build({ attempts: 5 }).send({ method: 'GET', url: `${origin}/x` });

    expect(requests).toHaveLength(1);
  });

  it('stops as soon as an attempt succeeds', async () => {
    let seen = 0;
    handler = () => {
      seen += 1;
      return seen === 1 ? { status: 503 } : { status: 200, body: 'ok' };
    };

    const result = await build({ attempts: 3 }).send({
      method: 'GET',
      url: `${origin}/x`,
    });

    expect(unwrap(result).status).toBe(200);
    expect(requests).toHaveLength(2);
  });
});

describe('Retry-After beats local backoff', () => {
  it('parses delta-seconds', () => {
    const headers = new Headers({ 'retry-after': '2' });
    expect(retryAfter(headers, new Date(), seconds(60))).toBe(2000);
  });

  it('parses an HTTP-date', () => {
    const now = new Date('2026-08-23T10:00:00Z');
    const headers = new Headers({
      'retry-after': 'Sun, 23 Aug 2026 10:00:05 GMT',
    });
    expect(retryAfter(headers, now, seconds(60))).toBe(5000);
  });

  it('treats a date in the past as now', () => {
    const now = new Date('2026-08-23T10:00:00Z');
    const headers = new Headers({
      'retry-after': 'Sun, 23 Aug 2026 09:00:00 GMT',
    });
    expect(retryAfter(headers, now, seconds(60))).toBe(0);
  });

  it('caps a hostile value rather than parking a worker until next year', () => {
    const headers = new Headers({ 'retry-after': '99999999' });
    expect(retryAfter(headers, new Date(), seconds(60))).toBe(60_000);
  });

  it('ignores a value it cannot read', () => {
    expect(
      retryAfter(
        new Headers({ 'retry-after': 'soon' }),
        new Date(),
        seconds(60),
      ),
    ).toBeUndefined();
  });

  it('is used instead of the computed backoff', async () => {
    // The server knows how long the rate limit actually has left; local backoff
    // is a guess competing with a fact.
    handler = () => ({ status: 429, headers: { 'retry-after': '1' } });
    const waits: number[] = [];

    const client = makeClient({
      clock,
      retry: makeRetry(
        {
          sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        },
        fakeRandom(),
      ),
      breaker: makeBreaker(clock),
      attempts: 2,
    });

    await client.send({ method: 'GET', url: `${origin}/x` });

    expect(waits).toEqual([1000]);
  });
});

describe('provenance goes on the wire', () => {
  const origins = makeOrigins(fakeIds(clock));

  it('sends correlation, causation and traceparent', async () => {
    const provenance = origins.forRequest({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });

    await Carrier.run(provenance, () =>
      build().send({ method: 'GET', url: `${origin}/x` }),
    );

    const sent = requests[0]?.headers ?? {};
    expect(sent['x-correlation-id']).toBe(provenance.correlationId);
    // The parent request id: the upstream's own request is the child.
    expect(sent['x-causation-id']).toBe(provenance.requestId);
    expect(sent['traceparent']).toBe(provenance.traceparent);
  });

  it('does NOT send the actor by default', async () => {
    // Propagating who is acting to an arbitrary third party is an information
    // leak — the recipient learns your user identifiers for free, and cannot
    // verify the claim anyway.
    await Carrier.run(origins.forBoot(), () =>
      build().send({ method: 'GET', url: `${origin}/x` }),
    );

    expect(requests[0]?.headers['x-actor']).toBeUndefined();
  });

  it('sends the actor when the caller opts in', async () => {
    const provenance = origins.forBoot();

    await Carrier.run(provenance, () =>
      build().send({ method: 'GET', url: `${origin}/x`, forwardActor: true }),
    );

    expect(requests[0]?.headers['x-actor']).toBe(String(provenance.actor));
  });

  it('sends nothing when there is no ambient provenance', async () => {
    // A job at boot, or a call from a CLI. Absent, not empty.
    await build().send({ method: 'GET', url: `${origin}/x` });

    expect(requests[0]?.headers['x-correlation-id']).toBeUndefined();
  });
});

describe('a per-attempt timeout', () => {
  it('fires per attempt, not over the whole call', async () => {
    // A 30s budget spent as three 10s attempts is a different thing from one
    // 30s attempt.
    handler = () => ({ status: 200, body: 'ok', delayMs: 400 });

    const result = await build({ timeout: millis(80), attempts: 3 }).send({
      method: 'GET',
      url: `${origin}/slow`,
    });

    expect(kindOf(isErr(result) ? result.error : undefined)).toBe(Kind.Timeout);
    // Three attempts were made, each bounded — not one long one.
    expect(requests).toHaveLength(3);
  });
});

describe('the response body is capped', () => {
  it('stops reading rather than buffering whatever arrives', async () => {
    // Content-Length is a claim, not a limit. A hostile or broken upstream can
    // exhaust memory with one reply.
    handler = () => ({ status: 200, body: 'x'.repeat(50_000) });

    const result = await build({ maxBodyBytes: 1_000 }).send({
      method: 'GET',
      url: `${origin}/big`,
    });

    const response = unwrap(result);
    expect(response.truncated).toBe(true);
    expect(response.body.length).toBe(1_000);
  });

  it('leaves a body under the cap intact', async () => {
    handler = () => ({ status: 200, body: 'small' });

    const response = unwrap(
      await build({ maxBodyBytes: 1_000 }).send({
        method: 'GET',
        url: `${origin}/small`,
      }),
    );

    expect(response.truncated).toBe(false);
    expect(response.body).toBe('small');
  });
});

describe('the breaker', () => {
  const policy = {
    window: seconds(30),
    buckets: 10,
    minimumThroughput: 4,
    failureRatio: 0.5,
    resetAfter: seconds(15),
  };

  it('opens after the window fills with failures, then refuses without calling', async () => {
    handler = () => ({ status: 503 });
    const client = build({
      breaker: makeBreaker(clock, policy),
      attempts: 1,
    });

    for (let i = 0; i < 4; i++) {
      await client.send({ method: 'GET', url: `${origin}/x` });
    }
    const before = requests.length;

    const refused = await client.send({ method: 'GET', url: `${origin}/x` });

    expect(isErr(refused)).toBe(true);
    // Nothing reached the server: the circuit is doing its job.
    expect(requests).toHaveLength(before);
  });

  it('does not consume retries while open', async () => {
    // Retrying against a breaker that is refusing precisely to stop the traffic
    // is the opposite of what opening it was for.
    //
    // **Counted by waits, not by requests.** An open circuit refuses without
    // calling, so the request count is identical whether the retry loop ran
    // once or five times — which is what the first version of this test
    // measured, and why it passed with the circuit check removed. A retry that
    // is consumed sleeps first; one that is refused does not.
    handler = () => ({ status: 503 });
    const waits: number[] = [];
    const client = makeClient({
      clock,
      retry: makeRetry(
        {
          sleep: (ms) => {
            waits.push(ms);
            return Promise.resolve();
          },
        },
        fakeRandom(),
      ),
      breaker: makeBreaker(clock, policy),
      attempts: 5,
    });

    for (let i = 0; i < 4; i++) {
      await client.send({ method: 'GET', url: `${origin}/x` });
    }
    waits.length = 0;

    await client.send({ method: 'GET', url: `${origin}/x` });

    expect(waits).toEqual([]);
  });

  it('does NOT open on 4xx — the endpoint is up and rejecting us', async () => {
    // Opening here would remove a working dependency because somebody typed a
    // bad id.
    handler = () => ({ status: 404 });
    // **A breaker that counts everything**, deliberately. `breaker`'s own
    // default `countsAsFailure` is `isRetryable`, which already excludes a
    // 404 — so a test using the default cannot tell whether `httpclient`'s
    // policy works or whether the breaker's happened to agree. It passed with
    // the rule inverted for exactly that reason. Counting everything at the
    // breaker isolates the decision this module is responsible for.
    const breaker = makeBreaker(clock, {
      ...policy,
      countsAsFailure: () => true,
    });
    const client = build({ breaker, attempts: 1 });

    for (let i = 0; i < 10; i++) {
      await client.send({ method: 'GET', url: `${origin}/missing` });
    }

    // **The circuit's own state**, not the request count. Counting requests
    // cannot fail here: an open circuit refuses without calling, so the count
    // is unchanged whether or not the 404s counted — the first version of this
    // test asserted exactly that and passed with the rule inverted.
    expect(breaker.snapshot(new URL(origin).host).state).toBe('closed');
    expect(breaker.snapshot(new URL(origin).host).failures).toBe(0);
    expect(requests).toHaveLength(10);
  });

  it('does NOT open on 429 — a throttle is the upstream working', async () => {
    handler = () => ({ status: 429 });
    const breaker = makeBreaker(clock, {
      ...policy,
      countsAsFailure: () => true,
    });
    const client = build({ breaker, attempts: 1 });

    for (let i = 0; i < 10; i++) {
      await client.send({ method: 'GET', url: `${origin}/x` });
    }

    expect(breaker.snapshot(new URL(origin).host).state).toBe('closed');
    expect(breaker.snapshot(new URL(origin).host).failures).toBe(0);
  });

  it('admits exactly one probe when it reopens, and closes on its success', async () => {
    // The point of half-open is to ask the dependency a single question.
    // Letting the fleet through re-creates the load that opened the circuit.
    const fake = fakeClock();
    const breaker = makeBreaker(fake, policy);
    const client = build({ breaker, attempts: 1 });

    handler = () => ({ status: 503 });
    for (let i = 0; i < 4; i++) {
      await client.send({ method: 'GET', url: `${origin}/x` });
    }
    expect(breaker.snapshot(new URL(origin).host).state).toBe('open');

    // Past the reset window. **Monotonic, per rule M13** — a wall-clock breaker
    // would hold this open for an hour after a one-second NTP correction, and
    // it would be invisible until an upstream was unreachable and stayed that
    // way. Both `es` repos shipped that bug.
    await fake.advance(seconds(16));

    handler = () => ({ status: 200, body: 'ok' });
    const before = requests.length;

    // Two callers arrive at once; exactly one is let through to ask.
    const [a, b] = await Promise.all([
      client.send({ method: 'GET', url: `${origin}/x` }),
      client.send({ method: 'GET', url: `${origin}/x` }),
    ]);

    expect(requests.length - before).toBe(1);
    // One succeeded and one was refused as a probe already in flight.
    expect([isErr(a), isErr(b)].filter(Boolean)).toHaveLength(1);
    // The probe succeeded, so the circuit is closed again.
    expect(breaker.snapshot(new URL(origin).host).state).toBe('closed');
  });

  it('is per host, so one dead endpoint does not stop the others', async () => {
    handler = (req) =>
      (req.headers.host ?? '').includes('127.0.0.1')
        ? { status: 503 }
        : { status: 200 };
    const breaker = makeBreaker(clock, policy);
    const client = build({ breaker, attempts: 1 });

    for (let i = 0; i < 4; i++) {
      await client.send({ method: 'GET', url: `${origin}/x` });
    }

    // The dead host is open; a different host is untouched.
    expect(breaker.snapshot(new URL(origin).host).state).toBe('open');
    expect(breaker.snapshot('other.example:443').state).toBe('closed');
  });
});
