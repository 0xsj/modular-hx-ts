import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { millis, systemClock } from '../clock/index.js';
import { conflict, internal, invalid, notFound } from '../errors/index.js';
import { systemIds } from '../id/index.js';
import { makeOrigins } from '../provenance/index.js';
import { noopTelemetry } from '../telemetry/index.js';
import { type Handler, json, text } from '../edge/index.js';
import {
  type Server,
  chain,
  fastifyServer,
  nodeServer,
  TIMEOUTS,
} from './index.js';

/**
 * The same chain, behind both servers.
 *
 * **What must not vary is the observable behaviour**, so every case below runs
 * twice and the two answers are compared to each other rather than to a
 * transcript written by hand. A transcript can be edited to match whichever
 * adapter drifted; the other adapter cannot.
 */

const clock = systemClock();
const randomBytes = (count: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(count));

const handler: Handler = async (exchange) => {
  switch (exchange.request.path) {
    case '/ok':
      return json(200, { ok: true, method: exchange.request.method });
    case '/echo-body':
      return text(200, await exchange.request.body());
    case '/slow':
      // Longer than the read-header timeout the guard test configures. A
      // handler that is thinking is not a peer that has gone quiet.
      await new Promise((resolve) => setTimeout(resolve, 600));
      return text(200, 'worth waiting for');
    case '/missing':
      throw notFound('no such thing');
    case '/conflict':
      throw conflict('already exists');
    case '/invalid':
      throw invalid('the request cannot be accepted', [
        { field: 'email', message: 'is required' },
        { field: 'email', message: 'is not an address' },
        { field: 'age', message: 'must be positive' },
      ]);
    case '/boom':
      throw internal('pg: relation "users" does not exist');
    case '/panic':
      throw new TypeError('undefined is not a function');
    default:
      return text(404, 'no route');
  }
};

const built = chain(
  {
    clock,
    origins: makeOrigins(systemIds(clock, randomBytes)),
    telemetry: noopTelemetry(),
  },
  handler,
);

interface Running {
  readonly name: string;
  readonly server: Server;
  readonly base: string;
}

const running: Running[] = [];

beforeAll(async () => {
  for (const [name, make] of [
    ['node:http', nodeServer],
    ['fastify', fastifyServer],
  ] as const) {
    // Port 0: the kernel picks, so the suite never collides with a developer's
    // running stack or with itself under `--pool=threads`.
    const server = make({ host: '127.0.0.1', port: 0, handler: built });
    await server.start();

    const address = server.address();
    if (address === undefined) throw new Error(`${name} did not bind`);
    running.push({
      name,
      server,
      base: `http://127.0.0.1:${String(address.port)}`,
    });
  }
});

afterAll(async () => {
  await Promise.all(running.map((it) => it.server.stop()));
});

interface Observed {
  status: number;
  contentType: string | undefined;
  body: unknown;
  /** `instance` is the request id, so it differs by design; that it is there does not. */
  hasInstance: boolean;
  hasRequestId: boolean;
  hasCorrelationId: boolean;
  leaksErrorKind: boolean;
}

async function get(
  base: string,
  path: string,
  init: RequestInit = {},
): Promise<Observed> {
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();

  let body: unknown = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* a text body is a body too */
  }

  // Two servers mint two request ids, and a problem body carries one. Lift it
  // out rather than comparing it: the correlation it enables is asserted
  // separately, and leaving it in would make every comparison vacuously fail.
  let hasInstance = false;
  if (typeof body === 'object' && body !== null && 'instance' in body) {
    const { instance, ...rest } = body;
    hasInstance = typeof instance === 'string' && instance.length > 0;
    body = rest;
  }

  const id = response.headers.get('x-request-id');
  return {
    status: response.status,
    contentType: response.headers.get('content-type')?.split(';')[0]?.trim(),
    body,
    hasInstance,
    // The value differs per request by design; that it is present, and shaped
    // like a minted id, does not.
    hasRequestId: id !== null && /^[0-9a-f-]{36}$/.test(id),
    hasCorrelationId: response.headers.get('x-correlation-id') !== null,
    leaksErrorKind: response.headers.get('x-error-kind') !== null,
  };
}

/** Run one request through every adapter and assert they agree. */
async function bothAgree(
  path: string,
  init: RequestInit = {},
): Promise<Observed> {
  const seen = await Promise.all(
    running.map(
      async (it) => [it.name, await get(it.base, path, init)] as const,
    ),
  );

  const [first, ...rest] = seen;
  if (first === undefined) throw new Error('no servers running');

  for (const [name, observed] of rest) {
    expect(observed, `${name} differs from ${first[0]}`).toEqual(first[1]);
  }
  return first[1];
}

describe('both servers, one behaviour', () => {
  it('serves a handler response identically', async () => {
    const observed = await bothAgree('/ok');

    expect(observed.status).toBe(200);
    expect(observed.body).toEqual({ ok: true, method: 'GET' });
  });

  it('reads a request body identically', async () => {
    const observed = await bothAgree('/echo-body', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello',
    });

    expect(observed.body).toBe('hello');
  });

  it('puts a request id on every response, through either server', async () => {
    for (const path of ['/ok', '/missing', '/boom', '/panic']) {
      const observed = await bothAgree(path);
      expect(observed.hasRequestId, path).toBe(true);
      expect(observed.hasCorrelationId, path).toBe(true);
    }
  });

  it('renders RFC 9457 identically', async () => {
    const observed = await bothAgree('/conflict');

    expect(observed.status).toBe(409);
    expect(observed.contentType).toBe('application/problem+json');
    expect(observed.body).toMatchObject({
      type: '/problems/conflict',
      status: 409,
      detail: 'already exists',
    });
    // Which is what joins this body to the log line that recorded it.
    expect(observed.hasInstance).toBe(true);
  });

  it('returns every validation problem at once, through either server', async () => {
    const observed = await bothAgree('/invalid');

    expect(observed.status).toBe(400);
    expect((observed.body as { errors: unknown }).errors).toEqual({
      email: ['is required', 'is not an address'],
      age: ['must be positive'],
    });
  });

  it('generalises a 500 and names no implementation', async () => {
    const observed = await bothAgree('/boom');

    expect(observed.status).toBe(500);
    expect(JSON.stringify(observed.body)).not.toContain('relation');
    expect(observed.body).toMatchObject({
      detail: 'The request could not be completed.',
    });
  });

  it('makes a panic indistinguishable from a returned internal error', async () => {
    // Across both servers *and* both causes: four responses, one shape.
    const panic = await bothAgree('/panic');
    const returned = await bothAgree('/boom');

    expect(panic).toEqual(returned);
  });

  it('never leaks the internal err_kind header', async () => {
    const observed = await bothAgree('/missing');

    expect(observed.leaksErrorKind).toBe(false);
  });

  it('adopts a correlation id and echoes it back', async () => {
    const correlation = 'corr-from-the-caller';

    for (const it of running) {
      const response = await fetch(`${it.base}/ok`, {
        headers: { 'x-correlation-id': correlation },
      });
      await response.text();

      expect(response.headers.get('x-correlation-id'), it.name).toBe(
        correlation,
      );
      // And still mints its own request id rather than reusing the caller's.
      expect(response.headers.get('x-request-id'), it.name).not.toBe(
        correlation,
      );
    }
  });

  it('never adopts a request id, through either server', async () => {
    for (const it of running) {
      const response = await fetch(`${it.base}/ok`, {
        headers: { 'x-request-id': 'forged-by-caller' },
      });
      await response.text();

      expect(response.headers.get('x-request-id'), it.name).not.toBe(
        'forged-by-caller',
      );
    }
  });
});

describe('the timeouts are values, not omissions', () => {
  it('orders the four so a balancer closes before the server does', () => {
    expect(TIMEOUTS.readHeader).toBeGreaterThan(0);
    expect(TIMEOUTS.read).toBeGreaterThan(0);
    expect(TIMEOUTS.write).toBeGreaterThan(0);
    // Idle outlives a typical balancer's 60s, so the balancer closes first and
    // a client never races a half-closed connection.
    expect(TIMEOUTS.idle).toBeGreaterThan(TIMEOUTS.read);
  });

  /**
   * Open a connection, send a partial request, and see whether the server ends
   * it. Resolves with how long that took, or `undefined` if it never happened.
   */
  function slowloris(port: number, partial: string, limit: number) {
    return new Promise<number | undefined>((resolve) => {
      const startedAt = Date.now();
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(partial);
      });

      const giveUp = setTimeout(() => {
        socket.destroy();
        resolve(undefined);
      }, limit);

      socket.on('close', () => {
        clearTimeout(giveUp);
        resolve(Date.now() - startedAt);
      });
      socket.on('error', () => {
        clearTimeout(giveUp);
        resolve(Date.now() - startedAt);
      });
    });
  }

  /**
   * **This is what a default-by-omission costs.** With no read-header timeout,
   * a peer that opens a connection and sends one line holds it, and enough of
   * them hold every connection the process has. Asserted with a short timeout
   * rather than the shipped ten seconds, because what is being proved is that
   * the configured value is *applied* — not what the number is.
   */
  it('disconnects a peer that never finishes its headers', async () => {
    const timeouts = {
      ...TIMEOUTS,
      readHeader: millis(300),
      read: millis(300),
    };

    for (const [name, make] of [
      ['node:http', nodeServer],
      ['fastify', fastifyServer],
    ] as const) {
      const server = make({
        host: '127.0.0.1',
        port: 0,
        handler: built,
        timeouts,
        // The abandoned connection is the point of the test, not a surprise.
        onError: () => undefined,
      });
      await server.start();

      try {
        const port = server.address()?.port ?? 0;
        // A request line and nothing else: the headers never terminate.
        const took = await slowloris(
          port,
          'GET /ok HTTP/1.1\r\nHost: x\r\n',
          4_000,
        );

        expect(took, `${name} held the connection open`).toBeDefined();
        expect(took ?? Infinity, name).toBeLessThan(3_000);

        // **And the guard is released once the headers arrive.** Armed for the
        // whole connection it would be a 300ms request timeout wearing a
        // slowloris timer's name, and a handler that thinks for half a second
        // would be cut off mid-answer.
        const slow = await fetch(`http://127.0.0.1:${String(port)}/slow`);
        expect(await slow.text(), name).toBe('worth waiting for');
      } finally {
        await server.stop();
      }
    }
  });
});
