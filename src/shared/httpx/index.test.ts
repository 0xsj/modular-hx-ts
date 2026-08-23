import { describe, expect, it } from 'vitest';
import { fakeClock, millis, seconds } from '../clock/index.js';
import {
  canceled,
  conflict,
  forbidden,
  internal,
  invalid,
  Kind,
  notFound,
  unavailable,
  unauthenticated,
  unprocessable,
  exhausted,
} from '../errors/index.js';
import { fakeIds } from '../id/index.js';
import { Actor, Carrier, makeOrigins } from '../provenance/index.js';
import { unwrap } from '../result/index.js';
import { memoryTelemetry } from '../telemetry/index.js';
import {
  type Exchange,
  type Handler,
  type Middleware,
  type Request,
  type Response,
  json,
  text,
} from '../edge/index.js';
import { chain, POSITIONS, problemFor, statusFor } from './index.js';

const clock = fakeClock();

function request(over: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/things',
    query: {},
    headers: {},
    peer: '127.0.0.1',
    body: () => Promise.resolve(''),
    ...over,
  };
}

/** The exchange an adapter hands in: position 1 replaces the provenance. */
const inbound = (over: Partial<Request> = {}): Exchange =>
  ({ request: request(over), remaining: () => seconds(30) }) as Exchange;

function run(
  handler: Handler,
  over: Partial<Parameters<typeof chain>[0]> = {},
  req: Partial<Request> = {},
): Promise<Response> {
  const built = chain(
    {
      clock,
      origins: makeOrigins(fakeIds(clock)),
      telemetry: memoryTelemetry(clock),
      ...over,
    },
    handler,
  );
  return built(inbound(req));
}

const ok: Handler = () => Promise.resolve(json(200, { ok: true }));

describe('the order is the contract', () => {
  it('is the one MODULES.md §5 specifies', () => {
    // Eight repos each inventing a plausible order produces eight different
    // answers to "does a 429 carry a request id".
    expect(POSITIONS).toEqual([
      'provenance',
      'access-log',
      'problem-mapper',
      'recover',
      'deadline',
      'authn',
      'ratelimit',
      'tenant',
      'idempotency',
      // Joins at 9, inside idempotency. `../../../MODULES.md` §5.
      'conditional',
      'handler',
    ]);
  });

  it('runs the filled slots in that order, outermost first', async () => {
    const seen: string[] = [];
    const spy =
      (name: string): Middleware =>
      (exchange, next) => {
        seen.push(name);
        return next(exchange);
      };

    await run(
      (e) => {
        seen.push('handler');
        void e;
        return Promise.resolve(json(200, {}));
      },
      {
        deadline: spy('deadline'),
        ratelimit: spy('ratelimit'),
        idempotency: spy('idempotency'),
        conditional: spy('conditional'),
        authenticate: () => {
          seen.push('authn');
        },
        resolveTenant: () => {
          seen.push('tenant');
        },
      },
    );

    expect(seen).toEqual([
      'deadline',
      'authn',
      'ratelimit',
      'tenant',
      'idempotency',
      'conditional',
      'handler',
    ]);
  });

  it('leaves the three slots empty and passes straight through', async () => {
    // Named and empty, not described in a comment. A slot added after three
    // modules have chosen their own insertion point is the expensive retrofit.
    const response = await run(ok);

    expect(response.status).toBe(200);
  });
});

describe('what the chain guarantees that no middleware does', () => {
  it('puts a request id on EVERY response', async () => {
    const cases: Handler[] = [
      ok,
      () => Promise.reject(exhausted('slow down')), // the 429
      () => {
        throw new TypeError('boom'); // the panic
      },
    ];

    for (const handler of cases) {
      const response = await run(handler);
      expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('builds every error body in exactly one place', async () => {
    // A handler that writes its own problem response is a bug the chain makes
    // impossible: everything below throws, and only the mapper renders.
    const response = await run(() => Promise.reject(notFound('no such thing')));

    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(response.body)).toMatchObject({
      type: '/problems/not_found',
      title: 'Not found',
      status: 404,
      detail: 'no such thing',
    });
  });

  it('makes a panic and a returned error indistinguishable', async () => {
    // **Why recover sits inside the mapper.** Caught above it, a panic would
    // have to render its own body, and then there are two places that build
    // one.
    const thrown = await run(() => {
      throw new TypeError('undefined is not a function');
    });
    const returned = await run(() => Promise.reject(internal('deliberate')));

    expect(thrown.status).toBe(returned.status);
    expect(thrown.headers['content-type']).toBe(
      returned.headers['content-type'],
    );

    const a = JSON.parse(thrown.body) as Record<string, unknown>;
    const b = JSON.parse(returned.body) as Record<string, unknown>;
    // Same shape, same generic detail. Only the instance differs.
    expect({ ...a, instance: null }).toEqual({ ...b, instance: null });
  });

  it('logs the status that finally emerges, not the one intended', async () => {
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];

    await run(() => Promise.reject(conflict('already exists')), {
      reporter: {
        info: (message, fields) => {
          lines.push({ message, ...(fields === undefined ? {} : { fields }) });
        },
        error: () => undefined,
      },
    });

    expect(lines[0]?.fields?.['status']).toBe(409);
  });

  it('carries err_kind on the log line, not only the status', async () => {
    // Two different Kinds can produce the same status, and the status alone
    // cannot tell you which.
    const lines: Record<string, unknown>[] = [];

    await run(() => Promise.reject(invalid('bad')), {
      reporter: {
        info: (_m, fields) => lines.push(fields ?? {}),
        error: () => undefined,
      },
    });

    expect(lines[0]?.['err_kind']).toBe('invalid');
    expect(lines[0]?.['status']).toBe(400);
  });

  it('never leaks the internal err_kind header to the client', async () => {
    const response = await run(() => Promise.reject(invalid('bad')));

    expect(response.headers['x-error-kind']).toBeUndefined();
  });
});

describe('problem mapping', () => {
  it('is conformance case 3, exactly — every kind, its own status', () => {
    expect(statusFor(Kind.Invalid)).toBe(400);
    expect(statusFor(Kind.Unauthenticated)).toBe(401);
    expect(statusFor(Kind.Forbidden)).toBe(403);
    expect(statusFor(Kind.NotFound)).toBe(404);
    expect(statusFor(Kind.Conflict)).toBe(409);
    // Case 29. Proposed rather than settled; see ADR 0011.
    expect(statusFor(Kind.PreconditionFailed)).toBe(412);
    expect(statusFor(Kind.Unprocessable)).toBe(422);
    expect(statusFor(Kind.Exhausted)).toBe(429);
    expect(statusFor(Kind.Canceled)).toBe(499);
    expect(statusFor(Kind.Internal)).toBe(500);
    expect(statusFor(Kind.Unavailable)).toBe(503);
    expect(statusFor(Kind.Timeout)).toBe(504);
  });

  it('is TOTAL, which is why 0010 chose a Kind over a status on the error', () => {
    // A status a caller could attach to an error makes this table advisory:
    // "mapped in exactly one place" stops being a property and becomes a
    // convention. Every kind maps, and no kind maps twice.
    const statuses = Object.values(Kind).map(statusFor);

    expect(statuses).toHaveLength(12);
    expect(statuses.every((status) => Number.isInteger(status))).toBe(true);
    expect(new Set(statuses).size).toBe(12);
  });

  it('distinguishes unprocessable from invalid in the body, not only the status', () => {
    // 400 means the request could not be understood; 422 means it was
    // understood and refused. A client that can only tell them apart by status
    // has to parse two things to learn one.
    expect(problemFor(invalid('not JSON')).type).toBe('/problems/invalid');
    expect(problemFor(unprocessable('the key was used differently')).type).toBe(
      '/problems/unprocessable',
    );
  });

  it('returns EVERY validation problem at once, keyed by field path', async () => {
    // Case 2. Never the first failure alone — a caller fixing one field per
    // round trip is the same waste `env` refuses at boot.
    const response = await run(() =>
      Promise.reject(
        invalid('the request cannot be accepted', [
          { field: 'email', message: 'is required' },
          { field: 'email', message: 'is not an address' },
          { field: 'age', message: 'must be positive' },
        ]),
      ),
    );

    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { errors: unknown }).errors).toEqual({
      email: ['is required', 'is not an address'],
      age: ['must be positive'],
    });
  });

  it('never leaks an upstream body', async () => {
    // Case 4. `httpclient` already refuses to put one in a message; this is the
    // second half of that promise, and it renders from the Kind alone.
    const upstream = unavailable('upstream api.example.com returned 503', {
      details: { body: '<html>Traceback: /srv/app/secret.py</html>' },
    });

    const response = await run(() => Promise.reject(upstream));

    expect(response.status).toBe(503);
    expect(response.body).not.toContain('Traceback');
    expect(response.body).not.toContain('secret.py');
    expect(JSON.parse(response.body)).toMatchObject({
      detail: 'The request could not be completed.',
    });
  });

  it('keeps a 4xx detail, because the caller can act on it', () => {
    expect(problemFor(notFound('no such user')).detail).toBe('no such user');
    expect(problemFor(forbidden('not permitted')).detail).toBe('not permitted');
  });

  it('generalises a 5xx detail, because the caller cannot', () => {
    // The message on an internal error names an implementation.
    expect(
      problemFor(internal('pg: relation "users" does not exist')).detail,
    ).toBe('The request could not be completed.');
  });

  it('puts the request id in `instance`, so a body joins to a log line', () => {
    expect(problemFor(notFound('x'), 'req-1').instance).toBe('req-1');
  });

  it('maps an unauthenticated failure to 401, not 403', () => {
    expect(problemFor(unauthenticated('no credentials')).status).toBe(401);
  });
});

describe('a cancellation is recorded, never rendered', () => {
  it('sends no problem body, because there is nobody to send one to', async () => {
    // Decision 0010: 499 is for the log, not the wire. Building a body would
    // spend work serialising a document into a closed socket, and would put a
    // *response* in the access log where a truncated exchange belongs. Same
    // rule as the late-error case, reached by a different route.
    const response = await run(() =>
      Promise.reject(canceled('client hung up')),
    );

    expect(response.status).toBe(499);
    expect(response.body).toBe('');
    expect(response.headers['content-type']).toBeUndefined();
  });

  it('still records what happened', async () => {
    const lines: Record<string, unknown>[] = [];

    await run(() => Promise.reject(canceled('client hung up')), {
      reporter: {
        info: (_m, fields) => lines.push(fields ?? {}),
        error: () => undefined,
      },
    });

    // The whole point of the value existing: the access log says what happened
    // instead of recording a request that simply stops.
    expect(lines[0]?.['err_kind']).toBe('canceled');
    expect(lines[0]?.['status']).toBe(499);
  });

  it('does not leak the err_kind header on the way out either', async () => {
    const response = await run(() => Promise.reject(canceled('gone')));

    expect(response.headers['x-error-kind']).toBeUndefined();
  });
});

describe('provenance at the boundary', () => {
  const headers = {
    'x-correlation-id': 'corr-abc',
    'x-causation-id': 'cause-xyz',
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  };

  it('adopts correlation, causation and traceparent', async () => {
    let seen:
      | {
          correlation: string;
          causation: string | undefined;
          trace: string | undefined;
        }
      | undefined;

    await run(
      (e) => {
        seen = {
          correlation: e.provenance.correlationId,
          causation: e.provenance.causationId,
          trace: e.provenance.traceparent,
        };
        return Promise.resolve(json(200, {}));
      },
      {},
      { headers },
    );

    expect(seen?.correlation).toBe('corr-abc');
    expect(seen?.causation).toBe('cause-xyz');
    expect(seen?.trace).toBe(headers.traceparent);
  });

  it('MINTS the request id and never adopts one', async () => {
    // A caller-supplied id lets two requests share an identity, breaking
    // idempotency reasoning and audit uniqueness. The allowlist type refuses
    // it; this asserts the behaviour that type buys.
    let requestId = '';

    const response = await run(
      (e) => {
        requestId = e.provenance.requestId;
        return Promise.resolve(json(200, {}));
      },
      {},
      { headers: { ...headers, 'x-request-id': 'forged-by-caller' } },
    );

    expect(requestId).not.toBe('forged-by-caller');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    // And the response echoes the minted one, not the caller's — echoing it
    // back is the observable half of the same bypass.
    expect(response.headers['x-request-id']).toBe(requestId);
  });

  it('never adopts an actor — that would be an authentication bypass', async () => {
    let actor = '';

    await run(
      (e) => {
        actor = String(e.provenance.actor);
        return Promise.resolve(json(200, {}));
      },
      {},
      { headers: { 'x-actor': 'user:someone-else' } },
    );

    expect(actor).toBe('anonymous:');
  });

  it('drops a malformed adopted value rather than failing the request', async () => {
    // Provenance grants nothing, so a broken trace link is cheaper than a
    // rejected request.
    let correlation = '';

    const response = await run(
      (e) => {
        correlation = e.provenance.correlationId;
        return Promise.resolve(json(200, {}));
      },
      {},
      { headers: { 'x-correlation-id': 'has spaces and\tcontrol' } },
    );

    expect(response.status).toBe(200);
    expect(correlation).not.toContain(' ');
  });

  it('is ambient below position 1', async () => {
    let ambient: string | undefined;

    await run(() => {
      ambient = Carrier.current()?.requestId;
      return Promise.resolve(json(200, {}));
    });

    expect(ambient).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('position 6 sets the actor, position 8 the tenant', () => {
  it('sets the actor after credentials verify', async () => {
    let actor = '';

    await run(
      (e) => {
        actor = String(e.provenance.actor);
        return Promise.resolve(json(200, {}));
      },
      {
        authenticate: (e) => {
          e.provenance = e.provenance.withActor(
            unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844')),
          );
        },
      },
    );

    expect(actor).toBe('user:01a024c7-d2d6-7e71-8c87-e344e27ef844');
  });

  it('sets the tenant after the resolver runs', async () => {
    let tenant: string | undefined;

    await run(
      (e) => {
        tenant = e.provenance.tenant;
        return Promise.resolve(json(200, {}));
      },
      {
        resolveTenant: (e) => {
          e.provenance = e.provenance.withTenant('t_acme');
        },
      },
    );

    expect(tenant).toBe('t_acme');
  });

  it('renders an authn refusal through the same mapper', async () => {
    const response = await run(ok, {
      authenticate: () => {
        throw unauthenticated('no credentials');
      },
    });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('renders a tenant refusal as 404, so a tenant is invisible', async () => {
    const response = await run(ok, {
      resolveTenant: () => {
        throw notFound('no such tenant');
      },
    });

    expect(response.status).toBe(404);
  });
});

describe('position 5 has a budget to spend, though nothing spends it', () => {
  it('exposes the request’s remaining budget from the context', async () => {
    // RESILIENCE.md §4: leave it reachable so `deadline` becomes arithmetic
    // over a value that already exists rather than a new thing threaded
    // through every handler.
    let remaining = 0;

    await run(
      (e) => {
        remaining = e.remaining();
        return Promise.resolve(json(200, {}));
      },
      { budget: seconds(5) },
    );

    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it('shrinks as the request proceeds, and never goes negative', async () => {
    const own = fakeClock();
    let remaining = -1;

    await chain(
      {
        clock: own,
        origins: makeOrigins(fakeIds(own)),
        telemetry: memoryTelemetry(own),
        budget: millis(100),
      },
      async (e) => {
        await own.advance(seconds(1));
        remaining = e.remaining();
        return json(200, {});
      },
    )(inbound());

    expect(remaining).toBe(0);
  });
});

describe('a handler cannot write its own problem response', () => {
  it('because the only way out is to throw', async () => {
    // A handler *can* return a 400 with a text body — nothing stops it — but
    // it cannot produce a *problem* body, because the mapper is the only code
    // that builds one and it only runs on a throw.
    const response = await run(() =>
      Promise.resolve(text(400, 'my own error format')),
    );

    expect(response.headers['content-type']).not.toBe(
      'application/problem+json',
    );
    // And it still gets a request id, which is position 1's job regardless.
    expect(response.headers['x-request-id']).toBeDefined();
  });
});
