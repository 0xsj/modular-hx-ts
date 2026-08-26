/**
 * `webhooks`, end to end through its own handler, bus and worker.
 *
 * **The receiver is a `fetch` this file controls**, which is what makes every
 * case below about behaviour rather than about the network: a 500 that recovers
 * on the third attempt, a 410 that retires an endpoint, a host that never
 * answers. `httpclient` was written months before anything called it and this
 * is the first suite that does.
 */

import { describe, expect, it } from 'vitest';
import { subject } from '../../shared/authz/index.js';
import { fakeClock, millis } from '../../shared/clock/index.js';
import { ephemeralKeyring, makeMac } from '../../shared/crypto/index.js';
import { type Request, type Response } from '../../shared/edge/index.js';
import { memoryEvents } from '../../shared/events/index.js';
import { fakeIds } from '../../shared/id/index.js';
import { chain } from '../../shared/httpx/index.js';
import { Actor, makeOrigins } from '../../shared/provenance/index.js';
import { fakeRandom } from '../../shared/random/index.js';
import { unwrap } from '../../shared/result/index.js';
import { memoryTelemetry } from '../../shared/telemetry/index.js';
import { worker } from '../../shared/work/index.js';
import { MAX_ATTEMPTS, SIGNATURE_HEADERS } from './domain/index.js';
import { makeWebhooks } from './index.js';

const ME = '019b76da-a800-7000-8000-0000000000b1';
const SOMEBODY = '019b76da-a800-7000-8000-0000000000b2';

interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** What the far end did. A queue of answers, then the last one forever. */
type Answer = { status: number; body?: string } | { throws: string };

function harness(answers: readonly Answer[] = [{ status: 200 }]) {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const random = fakeRandom(7);
  const origins = makeOrigins(ids);
  const bus = memoryEvents({ clock, ids });

  const received: Seen[] = [];
  let index = 0;

  const fetch = ((url: string, init: RequestInit) => {
    const headers = new Headers(init.headers ?? {});
    received.push({
      url,
      headers: Object.fromEntries(headers.entries()),
      body: typeof init.body === 'string' ? init.body : '',
    });

    const answer = answers[Math.min(index++, answers.length - 1)] ?? {
      status: 200,
    };
    if ('throws' in answer) {
      return Promise.reject(new TypeError(answer.throws));
    }
    return Promise.resolve(
      new Response(answer.body ?? 'ok', {
        status: answer.status,
        headers: { 'content-type': 'text/plain' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  let who = ME;

  const context = makeWebhooks({
    clock,
    ids,
    random,
    mac: makeMac(ephemeralKeyring(random)),
    publisher: bus,
    fetch,
    caller: () =>
      subject({
        actor: unwrap(Actor.user(who)),
        roles: [],
        tenant: 'acme',
      }),
  });

  bus.subscribe(context.subscription);

  const built = chain(
    { clock, origins, telemetry: memoryTelemetry(clock) },
    context.handler,
  );

  const call = (over: Partial<Request>): Promise<Response> =>
    built({
      request: {
        method: 'GET',
        path: '/v1/webhooks',
        headers: {},
        query: {},
        peer: '127.0.0.1',
        body: () => Promise.resolve(''),
        ...over,
      },
    } as never);

  const drain = () =>
    worker({ queue: context.queue, clock, handle: context.handle }).drain();

  return {
    context,
    clock,
    bus,
    origins,
    call,
    drain,
    received,
    as: (userId: string) => {
      who = userId;
    },
  };
}

const post = (path: string, body?: unknown): Partial<Request> => ({
  method: 'POST',
  path,
  headers: { 'content-type': 'application/json' },
  body: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
});

const json = (response: Response): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

async function register(
  h: ReturnType<typeof harness>,
  events: readonly string[] = ['identity.user.registered'],
): Promise<Record<string, unknown>> {
  const answer = await h.call(
    post('/v1/webhooks', { url: 'https://receiver.test/hooks', events }),
  );
  expect(answer.status, answer.body).toBe(201);
  return json(answer);
}

async function publish(
  h: ReturnType<typeof harness>,
  name = 'identity.user.registered',
): Promise<void> {
  await h.bus.publish(
    { name, payload: { subject: 'u-1' } },
    h.origins.forBoot(),
  );
}

describe('registration', () => {
  it('returns the secret ONCE and never again', async () => {
    // The store holds a fingerprint, so this value cannot be recovered. That is
    // a worse afternoon for one integrator and the reason a leaked table is not
    // a set of forgeable signatures.
    const h = harness();
    const created = await register(h);

    expect(String(created['secret'])).toMatch(/^whsec_/);

    const read = json(
      await h.call({ path: `/v1/webhooks/${String(created['id'])}` }),
    );

    expect(read['secret']).toBeUndefined();
    // Nor the fingerprint: publishing it lets anybody who saw one response
    // confirm a guess offline.
    expect(JSON.stringify(read)).not.toContain('fingerprint');
  });

  it('refuses a destination that is not https', async () => {
    const answer = await harness().call(
      post('/v1/webhooks', {
        url: 'http://receiver.test/hooks',
        events: ['identity.user.registered'],
      }),
    );

    expect(answer.status).toBe(400);
  });

  it('refuses a subscription to the webhooks prefix', async () => {
    const answer = await harness().call(
      post('/v1/webhooks', {
        url: 'https://receiver.test/hooks',
        events: ['webhooks.delivery.failed'],
      }),
    );

    expect(answer.status).toBe(400);
  });

  it('shows a caller only their own endpoints', async () => {
    const h = harness();
    await register(h);
    h.as(SOMEBODY);

    const page = json(await h.call({ path: '/v1/webhooks' }));

    expect(page['items']).toEqual([]);
  });

  it('answers 404, not 403, for somebody else`s endpoint', async () => {
    // A 403 confirms the id names a real endpoint and turns guessing into
    // enumeration of other people's integrations.
    const h = harness();
    const created = await register(h);
    h.as(SOMEBODY);

    const answer = await h.call({
      path: `/v1/webhooks/${String(created['id'])}`,
    });

    expect(answer.status).toBe(404);
  });
});

describe('fan-out — one event, N deliveries', () => {
  it('delivers a published event to a subscribed endpoint', async () => {
    const h = harness();
    await register(h);

    await publish(h);
    await h.drain();

    expect(h.received).toHaveLength(1);
    expect(h.received[0]?.url).toBe('https://receiver.test/hooks');
    expect(JSON.parse(h.received[0]?.body ?? '{}')).toMatchObject({
      type: 'identity.user.registered',
      data: { subject: 'u-1' },
    });
  });

  it('does not deliver an event nobody subscribed to', async () => {
    const h = harness();
    await register(h, ['orgs.member.joined']);

    await publish(h, 'identity.user.registered');
    await h.drain();

    expect(h.received).toHaveLength(0);
  });

  it('NEVER fans out its own events, which would be a loop', async () => {
    // A delivery that fails publishes a failure event, which would produce a
    // delivery, which fails. The domain refuses the subscription and this
    // refuses the fan-out; either alone is enough today and neither alone
    // survives a second way to create an endpoint.
    const h = harness();
    await register(h, ['*']);

    await publish(h, 'identity.user.registered');
    await h.drain();
    const afterFirst = h.received.length;

    // Draining again would deliver the delivery-succeeded event if the guard
    // were missing, and then the delivery of *that*, and so on.
    await h.drain();
    await h.drain();

    expect(afterFirst).toBe(1);
    expect(h.received).toHaveLength(1);
  });

  it('signs with the delivery id, the timestamp, and the body', async () => {
    const h = harness();
    await register(h);

    await publish(h);
    await h.drain();

    const headers = h.received[0]?.headers ?? {};
    expect(headers[SIGNATURE_HEADERS.Id]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers[SIGNATURE_HEADERS.Timestamp]).toMatch(/^\d+$/);
    expect(headers[SIGNATURE_HEADERS.Signature]).toMatch(/^v1,/);
  });
});

describe('what happens when the far end misbehaves', () => {
  it('records the status and schedules another attempt', async () => {
    const h = harness([{ status: 500 }]);
    const created = await register(h);
    await publish(h);
    await h.drain();

    const log = json(
      await h.call({
        path: `/v1/webhooks/${String(created['id'])}/deliveries`,
      }),
    );
    const first = (log['items'] as Record<string, unknown>[])[0];

    expect(first?.['state']).toBe('pending');
    expect(first?.['next_attempt_at']).toBeDefined();
    expect((first?.['attempts'] as { status?: number }[])[0]?.status).toBe(500);
  });

  it('RETIRES the delivery on a 410, rather than trying five more times', async () => {
    // 410 Gone is the specified way for a receiver to retire an endpoint.
    // Honouring it is the difference between a good citizen and a service that
    // keeps knocking.
    const h = harness([{ status: 410 }]);
    const created = await register(h);
    await publish(h);
    await h.drain();

    const log = json(
      await h.call({
        path: `/v1/webhooks/${String(created['id'])}/deliveries`,
      }),
    );
    const first = (log['items'] as Record<string, unknown>[])[0];

    expect(first?.['state']).toBe('exhausted');
    expect(first?.['next_attempt_at']).toBeUndefined();
  });

  it('does not put the receiver`s body in the record', async () => {
    // `httpclient` refuses to put an upstream body in a message; repeating the
    // rule here keeps a receiver's error page out of our database and logs.
    //
    // **The first version asserted the absence of `ok`** — the body the fake
    // receiver returns — and failed, because `took_ms` contains those two
    // letters. A substring assertion against a two-character string tests the
    // alphabet. The marker below cannot occur by accident.
    const h = harness([{ status: 500, body: 'SECRET-STACK-TRACE' }]);
    const created = await register(h);
    await publish(h);
    await h.drain();

    const log = await h.call({
      path: `/v1/webhooks/${String(created['id'])}/deliveries`,
    });

    expect(log.body).not.toContain('SECRET-STACK-TRACE');
  });

  it('survives a host that never answers', async () => {
    const h = harness([{ throws: 'getaddrinfo ENOTFOUND receiver.test' }]);
    const created = await register(h);
    await publish(h);
    await h.drain();

    const log = json(
      await h.call({
        path: `/v1/webhooks/${String(created['id'])}/deliveries`,
      }),
    );
    const attempts = (log['items'] as Record<string, unknown>[])[0]?.[
      'attempts'
    ] as { status?: number; error?: string }[];

    // No status, because there was no response — and the aggregate says so
    // rather than inventing a zero.
    expect(attempts[0]?.status).toBeUndefined();
    expect(attempts[0]?.error).toBeTruthy();
  });
});

describe('replay', () => {
  it('gives an exhausted delivery a fresh budget and enqueues it', async () => {
    const h = harness([{ status: 410 }]);
    const created = await register(h);
    await publish(h);
    await h.drain();

    const log = json(
      await h.call({
        path: `/v1/webhooks/${String(created['id'])}/deliveries`,
      }),
    );
    const id = String((log['items'] as Record<string, unknown>[])[0]?.['id']);

    // **202, not 200** — the replay enqueues, it does not deliver.
    const replayed = await h.call(post(`/v1/deliveries/${id}/replay`));
    expect(replayed.status, replayed.body).toBe(202);
    expect(json(replayed)['state']).toBe('pending');

    const before = h.received.length;
    await h.drain();
    expect(h.received.length).toBe(before + 1);
  });

  it('refuses to replay somebody else`s delivery', async () => {
    const h = harness([{ status: 410 }]);
    const created = await register(h);
    await publish(h);
    await h.drain();
    const log = json(
      await h.call({
        path: `/v1/webhooks/${String(created['id'])}/deliveries`,
      }),
    );
    const id = String((log['items'] as Record<string, unknown>[])[0]?.['id']);

    h.as(SOMEBODY);
    const answer = await h.call(post(`/v1/deliveries/${id}/replay`));

    // A delivery id is not a capability: ownership is the endpoint's.
    expect(answer.status).toBe(404);
  });
});

describe('a disabled endpoint', () => {
  const disable = (h: ReturnType<typeof harness>, id: string) =>
    h.call({
      method: 'PATCH',
      path: `/v1/webhooks/${id}`,
      headers: { 'content-type': 'application/json' },
      body: () => Promise.resolve(JSON.stringify({ state: 'disabled' })),
    });

  it('QUEUES NOTHING while it is disabled', async () => {
    // Disabled at fan-out time means no delivery row at all — `wanting` only
    // returns enabled endpoints. Queueing rows nobody will ever send would be
    // building a backlog whose only possible future is being deleted.
    const h = harness();
    const created = await register(h);
    const id = String(created['id']);
    await disable(h, id);

    await publish(h);
    await h.drain();

    expect(h.received).toHaveLength(0);
    const log = json(await h.call({ path: `/v1/webhooks/${id}/deliveries` }));
    expect(log['items']).toEqual([]);
  });

  it('leaves an ALREADY QUEUED delivery pending rather than discarding it', async () => {
    // The other half, and the one that is not obvious: an endpoint disabled
    // between fan-out and attempt has deliveries in flight. Re-enabling should
    // send what was missed.
    const h = harness();
    const created = await register(h);
    const id = String(created['id']);

    await publish(h);
    await disable(h, id);
    await h.drain();

    expect(h.received).toHaveLength(0);
    const log = json(await h.call({ path: `/v1/webhooks/${id}/deliveries` }));
    expect((log['items'] as Record<string, unknown>[])[0]?.['state']).toBe(
      'pending',
    );
  });
});

describe('deletion', () => {
  it('takes the deliveries with it, in one commit', async () => {
    // Leaving them leaves rows referencing an endpoint nothing can look up,
    // and a queued job that fails forever on a destination that is gone.
    const h = harness();
    const created = await register(h);
    const id = String(created['id']);
    await publish(h);
    await h.drain();

    const gone = await h.call({ method: 'DELETE', path: `/v1/webhooks/${id}` });
    expect(gone.status).toBe(204);

    const log = await h.call({ path: `/v1/webhooks/${id}/deliveries` });
    expect(log.status).toBe(404);
  });
});

describe('the exhaustion path', () => {
  it('gives up after MAX_ATTEMPTS and says so', async () => {
    const h = harness([{ status: 500 }]);
    const created = await register(h);
    const id = String(created['id']);
    await publish(h);

    // **Twelve hours per round, because the schedule reaches ten.** Ten
    // minutes was the first version and it stalled at the third attempt — the
    // backoff had grown past it and the job was simply not due, which looks
    // exactly like a delivery that stopped retrying. A test that advances less
    // than the interval it is testing proves nothing either way.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await h.drain();
      // **Awaited.** `advance` is async — it releases sleeps whose deadline has
      // passed — and dropping the `await` left the clock exactly where it
      // started while the loop happily ran six times. Every drain after the
      // first found nothing due, which is indistinguishable from a delivery
      // that stopped retrying, and the assertion below was reporting a bug in
      // its own setup.
      await h.clock.advance(millis(12 * 60 * 60 * 1000));
    }

    const log = json(await h.call({ path: `/v1/webhooks/${id}/deliveries` }));
    const first = (log['items'] as Record<string, unknown>[])[0];

    // **Every attempt actually left the process.** Asserting only the state
    // would pass against a delivery that exhausted without ever being sent.
    expect(h.received).toHaveLength(MAX_ATTEMPTS);
    expect(first?.['total_attempts']).toBe(MAX_ATTEMPTS);
    expect(first?.['state']).toBe('exhausted');
  });
});
