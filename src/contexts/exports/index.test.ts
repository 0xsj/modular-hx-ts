/**
 * `exports`, end to end through its own handler and worker.
 *
 * The cases that matter are the five the conformance suite has been unable to
 * ask anybody: **202 with a `Location`**, a terminal state reported exactly
 * once, and an idempotency key that replays. Plus the two this context adds:
 * cancellation at a checkpoint, and an artifact that expires.
 */

import { describe, expect, it } from 'vitest';
import { subject } from '../../shared/authz/index.js';
import {
  memoryBlobStore,
  memoryBlobs,
  keysIn,
} from '../../shared/blob/index.js';
import { fakeClock, millis } from '../../shared/clock/index.js';
import { type Request, type Response } from '../../shared/edge/index.js';
import { memoryEvents } from '../../shared/events/index.js';
import { fakeIds } from '../../shared/id/index.js';
import { chain } from '../../shared/httpx/index.js';
import { Actor, makeOrigins } from '../../shared/provenance/index.js';
import { systemRandom } from '../../shared/random/index.js';
import { unwrap } from '../../shared/result/index.js';
import { memoryTelemetry } from '../../shared/telemetry/index.js';
import { idempotency, memoryRecords } from '../../shared/idempotency/index.js';
import { worker } from '../../shared/work/index.js';
import { makeExports } from './index.js';

const ME = '019b76da-a800-7000-8000-0000000000a1';
const SOMEBODY = '019b76da-a800-7000-8000-0000000000a2';

function harness(rows = 3) {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const random = systemRandom();
  const origins = makeOrigins(ids);
  const bus = memoryEvents({ clock, ids });
  const store = memoryBlobStore();
  const blobs = memoryBlobs(store, clock);

  let who = ME;
  let fail = false;

  const context = makeExports({
    clock,
    ids,
    random,
    publisher: bus,
    blobs,
    datasets: {
      rows: () =>
        (async function* () {
          await Promise.resolve();
          if (fail) throw new Error('the dataset exploded');
          for (let i = 0; i < rows; i++) {
            yield { id: `u-${String(i)}`, name: `Person, ${String(i)}` };
          }
        })(),
    },
    caller: () =>
      subject({
        actor: unwrap(Actor.user(who)),
        roles: [],
        tenant: 'acme',
      }),
  });

  const built = chain(
    { clock, origins, telemetry: memoryTelemetry(clock) },
    context.handler,
  );

  const call = (over: Partial<Request>): Promise<Response> =>
    built({
      request: {
        method: 'GET',
        path: '/v1/exports',
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
    call,
    drain,
    origins,
    store,
    blobs,
    as: (userId: string) => {
      who = userId;
    },
    explode: () => {
      fail = true;
    },
  };
}

const post = (path: string, body: unknown): Partial<Request> => ({
  method: 'POST',
  path,
  headers: { 'content-type': 'application/json' },
  body: () => Promise.resolve(JSON.stringify(body)),
});

const json = (response: Response): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

async function request(h: ReturnType<typeof harness>, format = 'csv') {
  const answer = await h.call(post('/v1/exports', { format }));
  expect(answer.status, answer.body).toBe(202);
  return answer;
}

describe('202 with a Location — conformance case 45', () => {
  it('accepts, and says where to poll', async () => {
    const h = harness();

    const answer = await request(h);

    expect(answer.status).toBe(202);
    expect(answer.headers['location']).toBe(
      `/v1/operations/${String(json(answer)['id'])}`,
    );
    expect(json(answer)['state']).toBe('running');
  });

  it('refuses a format nobody renders', async () => {
    const h = harness();

    const answer = await h.call(post('/v1/exports', { format: 'pdf' }));

    expect(answer.status).toBe(400);
  });
});

describe('polling to a terminal state — case 46', () => {
  it('is running before the worker, succeeded after', async () => {
    const h = harness();
    const accepted = await request(h);
    const id = String(json(accepted)['id']);

    const before = await h.call({ path: `/v1/operations/${id}` });
    await h.drain();
    const after = await h.call({ path: `/v1/operations/${id}` });

    expect(json(before)['state']).toBe('running');
    expect(json(after)['state']).toBe('succeeded');
    expect((json(after)['result'] as { href: string } | undefined)?.href).toBe(
      `/v1/exports/${id}/download`,
    );
  });

  it('spells the whole result snake case, not just the field a case asserts', async () => {
    // **The gap this closes is a spread.** `result` reached the wire as
    // `result: operation.result`, so `contentType` — the domain's TypeScript
    // spelling — was published on a wire §3.5 says is snake case. Conformance
    // case 45 reads `result.href` and nothing else, so neither suite looked at
    // the two fields beside it, and a view that spreads is a view that cannot
    // be caught by asserting the field somebody remembered.
    const h = harness();
    const accepted = await request(h);
    const id = String(json(accepted)['id']);
    await h.drain();

    const result = json(await h.call({ path: `/v1/operations/${id}` }))[
      'result'
    ] as Record<string, unknown>;

    expect(Object.keys(result).every((key) => !/[A-Z]/.test(key))).toBe(true);
    expect(result['content_type']).toBe('text/csv');
    expect(result['size']).toBeGreaterThan(0);
  });

  it('reports the terminal state EXACTLY once — byte for byte', async () => {
    // The property `operations` buys by refusing to move a settled state: two
    // polls of a finished operation are the same bytes, so a client that polls
    // twice cannot see it change under them.
    const h = harness();
    const id = String(json(await request(h))['id']);
    await h.drain();

    const first = await h.call({ path: `/v1/operations/${id}` });
    const second = await h.call({ path: `/v1/operations/${id}` });

    expect(second.body).toBe(first.body);
  });

  it('is failed when the work throws, with the reason', async () => {
    const h = harness();
    h.explode();
    const id = String(json(await request(h))['id']);

    await h.drain().catch(() => undefined);
    const answer = await h.call({ path: `/v1/operations/${id}` });

    expect(json(answer)['state']).toBe('failed');
    expect(String(json(answer)['error'])).toContain('exploded');
  });

  it('is 404, not 403, for somebody else`s operation', async () => {
    // A 403 confirms it exists and turns any id into an oracle for what other
    // people are exporting.
    const h = harness();
    const id = String(json(await request(h))['id']);

    h.as(SOMEBODY);
    const answer = await h.call({ path: `/v1/operations/${id}` });

    expect(answer.status).toBe(404);
  });
});

describe('cancellation is a state with checkpoint semantics', () => {
  it('stops the work and says so', async () => {
    const h = harness();
    const id = String(json(await request(h))['id']);

    const cancelled = await h.call({
      method: 'DELETE',
      path: `/v1/operations/${id}`,
    });
    await h.drain();
    const answer = await h.call({ path: `/v1/operations/${id}` });

    expect(cancelled.status).toBe(204);
    expect(json(answer)['state']).toBe('cancelled');
    // **Nothing was written.** The worker asked before settling and found the
    // operation abandoned.
    expect(keysIn(h.store)).toHaveLength(0);
  });

  it('is idempotent, because a client pressing twice is a client', async () => {
    const h = harness();
    const id = String(json(await request(h))['id']);
    const path = `/v1/operations/${id}`;

    expect((await h.call({ method: 'DELETE', path })).status).toBe(204);
    expect((await h.call({ method: 'DELETE', path })).status).toBe(204);
  });

  it('refuses to cancel one that already succeeded', async () => {
    // The artifact exists. Pretending it does not is worse than saying no.
    const h = harness();
    const id = String(json(await request(h))['id']);
    await h.drain();

    const answer = await h.call({
      method: 'DELETE',
      path: `/v1/operations/${id}`,
    });

    expect(answer.status).toBe(409);
  });
});

describe('the download is a separate route, authorized at download time', () => {
  it('serves the artifact to its owner', async () => {
    const h = harness(2);
    const id = String(json(await request(h))['id']);
    await h.drain();

    const answer = await h.call({ path: `/v1/exports/${id}/download` });

    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toBe('text/csv');
    expect(answer.body).toContain('id,name');
    // **RFC 4180.** A naive join breaks on the first display name with a comma.
    expect(answer.body).toContain('"Person, 0"');
  });

  it('is 404 for somebody who is not the owner', async () => {
    const h = harness();
    const id = String(json(await request(h))['id']);
    await h.drain();

    h.as(SOMEBODY);
    const answer = await h.call({ path: `/v1/exports/${id}/download` });

    expect(answer.status).toBe(404);
  });

  it('is 404 before the work finishes', async () => {
    // There is no artifact yet, and the poll is where a caller learns that.
    const h = harness();
    const id = String(json(await request(h))['id']);

    expect((await h.call({ path: `/v1/exports/${id}/download` })).status).toBe(
      404,
    );
  });
});

describe('artifacts expire', () => {
  it('is servable inside the TTL and gone after it', async () => {
    // The TTL runs from when the artifact was **written**, not requested: an
    // export that took an hour would otherwise arrive already expired.
    const h = harness();
    const id = String(json(await request(h))['id']);
    await h.drain();

    expect((await h.call({ path: `/v1/exports/${id}/download` })).status).toBe(
      200,
    );

    await h.clock.advance(millis(25 * 60 * 60 * 1000));

    expect((await h.call({ path: `/v1/exports/${id}/download` })).status).toBe(
      404,
    );
  });

  it('the sweep drops the bytes and forgets the key', async () => {
    const h = harness();
    await request(h);
    await h.drain();
    expect(keysIn(h.store)).toHaveLength(1);

    await h.clock.advance(millis(25 * 60 * 60 * 1000));
    const swept = await h.context.sweep(h.origins.forCli('sweep'));

    expect(swept).toBe(1);
    expect(keysIn(h.store)).toHaveLength(0);
  });

  it('sweeps nothing that is still live', async () => {
    const h = harness();
    await request(h);
    await h.drain();

    expect(await h.context.sweep(h.origins.forCli('sweep'))).toBe(0);
  });
});

describe('idempotency — the first async consumer of it', () => {
  /**
   * The chain with **position 9** in it.
   *
   * `exports` is the first request in this repository that does not complete
   * synchronously, which makes it the first real test of a claim held across a
   * request that returns 202 and keeps working afterwards. `idempotency` has
   * been built, mounted and passing its own suite for days with nothing
   * exercising it end to end — these are the cases the conformance runner has
   * been unable to ask anybody.
   */
  function claimed(rows = 2) {
    const h = harness(rows);
    const clock = h.clock;
    const built = chain(
      {
        clock,
        origins: h.origins,
        telemetry: memoryTelemetry(clock),
        // Position 6 is what gives the claim a principal to scope by; without
        // one the middleware refuses, which is the wiring error it is meant to
        // be rather than a 401 nobody can act on.
        authenticate: (exchange) => {
          exchange.provenance = exchange.provenance.withActor(
            unwrap(Actor.user(ME)),
          );
          return Promise.resolve();
        },
        idempotency: idempotency({
          records: memoryRecords(clock),
          anonymousCallers: 'refused',
        }),
      },
      h.context.handler,
    );

    const call = (over: Partial<Request>): Promise<Response> =>
      built({
        request: {
          method: 'GET',
          path: '/v1/exports',
          headers: {},
          query: {},
          peer: '127.0.0.1',
          body: () => Promise.resolve(''),
          ...over,
        },
      } as never);

    return { ...h, call };
  }

  const keyed = (key: string, body: unknown): Partial<Request> => ({
    method: 'POST',
    path: '/v1/exports',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: () => Promise.resolve(JSON.stringify(body)),
  });

  it('replays the stored response bit for bit — case 25', async () => {
    // **And the export is requested once.** A replay that started a second
    // export would be a replay that cost money, which is the whole reason a
    // client sends the header.
    const h = claimed();

    const first = await h.call(keyed('k-replay', { format: 'csv' }));
    const second = await h.call(keyed('k-replay', { format: 'csv' }));

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body).toBe(first.body);
    expect(second.headers['idempotency-replayed']).toBe('true');
  });

  it('starts exactly ONE export for a replayed key', async () => {
    const h = claimed();

    await h.call(keyed('k-once', { format: 'csv' }));
    await h.call(keyed('k-once', { format: 'csv' }));
    await h.drain();

    expect(keysIn(h.store)).toHaveLength(1);
  });

  it('refuses the same key with a different payload — case 26', async () => {
    const h = claimed();

    await h.call(keyed('k-mismatch', { format: 'csv' }));
    const second = await h.call(keyed('k-mismatch', { format: 'json' }));

    expect(second.status).toBe(422);
    expect(json(second)['type']).toBe('/problems/idempotency-mismatch');
  });

  it('is unaffected by a key on a poll, which is safe', async () => {
    // A client library that attaches the header to every request is being
    // harmlessly thorough, and a 4xx would punish it for nothing.
    const h = claimed();
    const id = String(
      json(await h.call(keyed('k-poll', { format: 'csv' })))['id'],
    );

    const polled = await h.call({
      path: `/v1/operations/${id}`,
      headers: { 'idempotency-key': 'k-poll' },
    });

    expect(polled.status).toBe(200);
  });
});

describe('json is the other renderer', () => {
  it('produces an array', async () => {
    const h = harness(2);
    const id = String(json(await request(h, 'json'))['id']);
    await h.drain();

    const answer = await h.call({ path: `/v1/exports/${id}/download` });

    expect(answer.headers['content-type']).toBe('application/json');
    expect(JSON.parse(answer.body)).toHaveLength(2);
  });
});
