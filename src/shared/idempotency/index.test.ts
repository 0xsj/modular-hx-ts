import { describe, expect, it } from 'vitest';
import { millis, systemClock } from '../clock/index.js';
import {
  canceled,
  internal,
  invalid,
  notFound,
  unavailable,
  unprocessable,
} from '../errors/index.js';
import { fakeIds } from '../id/index.js';
import {
  type Exchange,
  type Handler,
  type Reporter,
  type Request,
  type Response,
  json,
  text,
} from '../edge/index.js';
import {
  type Validator,
  type Validators,
  conditional,
  formatETag,
  strongETag,
} from '../conditional/index.js';
import { chain } from '../httpx/index.js';
import { Actor, makeOrigins } from '../provenance/index.js';
import { unwrap } from '../result/index.js';
import { memoryTelemetry } from '../telemetry/index.js';
import { recordsContract } from './idempotencytest.js';
import {
  type Records,
  KEY_HEADER,
  MAX_STORED_BYTES,
  REPLAY_HEADER,
  idempotency,
  memoryRecords,
  storableHeaders,
} from './index.js';

const clock = systemClock();

describe('memory adapter', () => {
  recordsContract(() => ({
    name: 'memory',
    // A fresh store per call, so a case choosing its own lease is not sharing
    // records with one that did not.
    records: (options) => memoryRecords(clock, options),
  }));
});

// --- the middleware, through the real chain --------------------------------

const ALICE = unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef844'));
const BOB = unwrap(Actor.user('01a024c7-d2d6-7e71-8c87-e344e27ef900'));

interface Wiring {
  readonly records?: Records;
  readonly actor?: Actor;
  readonly tenant?: string;
  readonly reporter?: Reporter;
  /**
   * Wire `conditional` into position 9 as well, inside this module.
   *
   * Only the two crossing cases below use it — neither module's own suite can
   * reach the interaction, because it needs a precondition failure produced by
   * one and a release decision taken by the other.
   */
  readonly validators?: Validators;
}

function callable(handler: Handler, wiring: Wiring = {}) {
  const records = wiring.records ?? memoryRecords(clock);
  const actor = wiring.actor ?? ALICE;

  const built = chain(
    {
      clock,
      origins: makeOrigins(fakeIds(clock)),
      telemetry: memoryTelemetry(clock),
      ...(wiring.reporter === undefined ? {} : { reporter: wiring.reporter }),
      authenticate: (exchange) => {
        exchange.provenance = exchange.provenance.withActor(actor);
      },
      resolveTenant: (exchange) => {
        exchange.provenance = exchange.provenance.withTenant(
          wiring.tenant ?? 't_acme',
        );
      },
      // **The whole wiring.** The slot was named and empty; this is one line.
      idempotency: idempotency({
        records,
        anonymousCallers: 'refused',
        ...(wiring.reporter === undefined ? {} : { reporter: wiring.reporter }),
      }),
      ...(wiring.validators === undefined
        ? {}
        : { conditional: conditional({ validators: wiring.validators }) }),
    },
    handler,
  );

  return (over: Partial<Request> = {}): Promise<Response> => {
    const request: Request = {
      method: 'POST',
      path: '/payments',
      query: {},
      headers: {},
      peer: '127.0.0.1',
      body: () => Promise.resolve('{"amount":100}'),
      ...over,
    };
    return built({ request, remaining: () => millis(30_000) } as Exchange);
  };
}

const withKey = (
  key: string,
  over: Partial<Request> = {},
): Partial<Request> => ({
  ...over,
  headers: { [KEY_HEADER]: key, ...over.headers },
});

/** A handler that answers differently every time, so a replay is visible. */
function counting(): Handler {
  let calls = 0;
  return () => Promise.resolve(json(201, { call: ++calls }));
}

describe('conformance cases 25-28, end to end', () => {
  it('25 — replays the stored response, marked as a replay', async () => {
    const call = callable(counting());

    const first = await call(withKey('k1'));
    const second = await call(withKey('k1'));

    expect(first.status).toBe(201);
    expect(JSON.parse(first.body)).toEqual({ call: 1 });

    // Bit for bit: the handler ran once, and the second caller sees the first
    // answer rather than a second one.
    expect(second.status).toBe(first.status);
    expect(second.body).toBe(first.body);
    expect(second.headers[REPLAY_HEADER]).toBe('true');
    expect(first.headers[REPLAY_HEADER]).toBeUndefined();
  });

  it('26 — the same key with a different payload is 422', async () => {
    const call = callable(counting());

    await call(withKey('k2'));
    const second = await call(
      withKey('k2', { body: () => Promise.resolve('{"amount":999}') }),
    );

    expect(second.status).toBe(422);
    expect(second.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(second.body)).toMatchObject({
      type: '/problems/unprocessable',
      status: 422,
    });
  });

  it('27 — a key whose request is still in flight is 409', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const call = callable(async () => {
      await gate;
      return json(201, { ok: true });
    });

    const first = call(withKey('k3'));
    // The second arrives while the first is inside the handler.
    const second = await call(withKey('k3'));

    expect(second.status).toBe(409);

    release();
    expect((await first).status).toBe(201);
  });

  it('28 — a 5xx releases the key so a retry may proceed', async () => {
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(unavailable('the upstream is down'))
        : Promise.resolve(json(201, { ok: true }));
    });

    const first = await call(withKey('k4'));
    const second = await call(withKey('k4'));

    expect(first.status).toBe(503);
    // Released, so the retry *ran* rather than replaying the outage back.
    expect(second.status).toBe(201);
    expect(calls).toBe(2);
  });
});

describe('release: would it answer the same, and did anything happen', () => {
  it('holds a 4xx that answers the same way every time', async () => {
    // **The asymmetry, as a test rather than a comment.** Implemented as
    // "release on any error" this passes case 28 and fails here — and the
    // failure in production is a client retrying its way to a different
    // outcome, which is the one thing a key promises cannot happen.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.reject(notFound('no such account'));
    });

    const first = await call(withKey('k5'));
    const second = await call(withKey('k5'));

    expect(first.status).toBe(404);
    // Still claimed: 409, not a second execution.
    expect(second.status).toBe(409);
    expect(calls).toBe(1);
  });

  it('holds the key on a cancellation, which is nobody`s fault', async () => {
    // **Decision 0010's third branch, where it lands here.** A caller who hung
    // up tells us nothing about whether the write happened — the handler may
    // have finished, or not. Releasing would let a retry re-apply it; holding
    // costs a 409 until the lease and cannot double-charge anybody.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.reject(canceled('client hung up'));
    });

    await call(withKey('k5b'));
    const second = await call(withKey('k5b'));

    expect(second.status).toBe(409);
    expect(calls).toBe(1);
  });

  it('releases on a 5xx the handler *returns* rather than throws', async () => {
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.resolve(text(502, 'bad gateway'));
    });

    await call(withKey('k6'));
    await call(withKey('k6'));

    expect(calls).toBe(2);
  });

  it('stores a 4xx the handler *returns*, and replays it', async () => {
    // A handler that returns rather than throws gives position 9 something to
    // store, so the 4xx replays bit for bit.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.resolve(text(409, 'account already closed'));
    });

    const first = await call(withKey('k7'));
    const second = await call(withKey('k7'));

    expect(first.status).toBe(409);
    expect(second.body).toBe('account already closed');
    expect(second.headers[REPLAY_HEADER]).toBe('true');
    expect(calls).toBe(1);
  });
});

// --- the two cases that cross into `conditional` ---------------------------
//
// **Neither module's own suite can catch these.** They need a precondition
// failure produced by one module and a release decision taken by the other, and
// the answer is wrong in a way that looks right from inside either one.

describe('a precondition failure releases the key', () => {
  const holding = (tag: string): Wiring => ({
    validators: (): Validator => ({ etag: strongETag(tag) }),
  });

  const put = (key: string, ifMatch: string): Partial<Request> => ({
    method: 'PUT',
    headers: { [KEY_HEADER]: key, 'if-match': ifMatch },
  });

  it('lets a client that CORRECTED its validator make progress', async () => {
    // **The one that fails in every repo today**, under the obvious rule that a
    // 4xx holds. A 412 is not a deterministic answer to a malformed request: it
    // depends on server state, and a client that re-reads and sends a fresh
    // validator *should* get a different answer. Holding the key strands a
    // client who fixed their request properly — they have to invent a new key
    // to make progress on a request they already corrected.
    //
    // Releasing is safe for a reason specific to 412 rather than a loosening of
    // the rule: `conditional` sits inside this module and throws **before**
    // calling `next`, so nothing executed and there is no write to re-apply.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.resolve(json(200, { written: calls }));
    }, holding('v1'));

    // The client's cached validator is stale.
    const refused = await call(put('k-fix', '"v0"'));
    expect(refused.status).toBe(412);
    expect(calls).toBe(0);

    // It re-reads, learns the current tag, and retries with the SAME key — the
    // request it is making has not changed, only what it knows about the state.
    const accepted = await call(put('k-fix', '"v1"'));

    expect(accepted.status).toBe(200);
    expect(calls).toBe(1);
  });

  it('is not a licence to retry into a different outcome', async () => {
    // The guarantee the release must not cost: once something has actually
    // happened, the key holds. A second attempt with the same key replays.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.resolve(json(200, { written: calls }));
    }, holding('v1'));

    await call(put('k-once', '"v1"'));
    const replay = await call(put('k-once', '"v1"'));

    expect(replay.headers[REPLAY_HEADER]).toBe('true');
    expect(calls).toBe(1);
  });

  it('does NOT release a 4xx that will answer the same way again', async () => {
    // The rule that stayed. `invalid` and `unprocessable` are deterministic
    // answers to the request itself, so a retry gets 409 rather than a second
    // execution — and the release above must not have widened to them.
    for (const [key, error] of [
      ['k-inv', invalid('not JSON')],
      ['k-unp', unprocessable('understood, and refused')],
    ] as const) {
      const call = callable(() => Promise.reject(error));

      const first = await call(withKey(key));
      const second = await call(withKey(key));

      expect(first.status, key).not.toBe(409);
      expect(second.status, key).toBe(409);
    }
  });
});

describe('a replay is not re-evaluated', () => {
  it('replays the stored response even though the state has MOVED', async () => {
    // **Why `conditional` runs inside `idempotency` rather than outside it.**
    // The original request's preconditions were evaluated once, when they meant
    // something; re-evaluating them against state that has moved since would
    // turn a replay into a 412 and break case 25's *bit for bit*.
    //
    // Outside, this test returns 412 and the client can never retrieve the
    // answer to a request that already succeeded.
    let tag = 'v1';
    const validators: Validators = (): Validator => ({
      etag: strongETag(tag),
    });

    let calls = 0;
    const call = callable(
      () => {
        calls += 1;
        return Promise.resolve(json(200, { written: calls }));
      },
      { validators },
    );

    const first = await call({
      method: 'PUT',
      headers: {
        [KEY_HEADER]: 'k-moved',
        'if-match': formatETag(strongETag('v1')),
      },
    });
    expect(first.status).toBe(200);

    // Somebody else writes. The client's validator is now stale.
    tag = 'v2';

    const replay = await call({
      method: 'PUT',
      headers: {
        [KEY_HEADER]: 'k-moved',
        'if-match': formatETag(strongETag('v1')),
      },
    });

    expect(replay.status).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(replay.headers[REPLAY_HEADER]).toBe('true');
    expect(calls).toBe(1);
  });
});

describe('the key is scoped, never global', () => {
  it('does not replay one tenant`s response to another', async () => {
    // **Test this directly or nothing catches it.** Every other case in this
    // file uses one tenant, where a global key behaves identically.
    const records = memoryRecords(clock);
    const acme = callable(counting(), { records, tenant: 't_acme' });
    const globex = callable(counting(), { records, tenant: 't_globex' });

    const first = await acme(withKey('same-key-string'));
    const second = await globex(withKey('same-key-string'));

    expect(JSON.parse(first.body)).toEqual({ call: 1 });
    // A fresh execution in the other tenant, not a replay of Acme's body.
    expect(JSON.parse(second.body)).toEqual({ call: 1 });
    expect(second.headers[REPLAY_HEADER]).toBeUndefined();
  });

  it('does not replay one principal`s response to another', async () => {
    const records = memoryRecords(clock);
    const alice = callable(counting(), { records, actor: ALICE });
    const bob = callable(counting(), { records, actor: BOB });

    await alice(withKey('same-key-string-2'));
    const second = await bob(withKey('same-key-string-2'));

    expect(second.headers[REPLAY_HEADER]).toBeUndefined();
  });

  it('refuses the anonymous pairing at STARTUP, not per request', () => {
    // **Where the pairing is declared.** A route that required authentication
    // was already refused at position 6, so an anonymous caller reaching
    // position 9 means the route is public — and no status this module could
    // return would be true of it. ADR 0009.
    expect(() =>
      idempotency({
        records: memoryRecords(clock),
        anonymousCallers: 'permitted',
      }),
    ).toThrow(/anonymous/);
  });

  it('treats an anonymous caller reaching it as OUR mistake, not the client`s', async () => {
    // The runtime backstop, for a chain wired inconsistently with what it
    // declared. `Internal`: a misconfigured route is our bug. **Not 401** —
    // that asserts the endpoint requires authentication, which it demonstrably
    // does not, and breaks a client that did nothing worse than send a key.
    let calls = 0;
    const call = callable(
      () => {
        calls += 1;
        return Promise.resolve(json(201, {}));
      },
      { actor: Actor.anonymous() },
    );

    const response = await call(withKey('k8'));

    expect(response.status).toBe(500);
    expect(calls).toBe(0);
  });
});

describe('the fingerprint is canonical, not raw bytes', () => {
  it('does not fire 422 on a re-serialized identical payload', async () => {
    // **The reason it is a canonical digest.** Raw bytes make this a 422, and a
    // client whose JSON library orders keys differently between retries is then
    // punished for a safe retry.
    const call = callable(counting());

    const first = await call(
      withKey('k9', {
        body: () => Promise.resolve('{"amount":100,"currency":"usd"}'),
      }),
    );
    const second = await call(
      withKey('k9', {
        body: () => Promise.resolve('{ "currency":"usd",  "amount":100 }'),
      }),
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers[REPLAY_HEADER]).toBe('true');
  });

  it('distinguishes the same body on a different path', async () => {
    const records = memoryRecords(clock);
    const call = callable(counting(), { records });

    await call(withKey('k10', { path: '/payments' }));
    const second = await call(withKey('k10', { path: '/refunds' }));

    expect(second.status).toBe(422);
  });
});

describe('the store fails closed', () => {
  it('answers 503 rather than proceeding unclaimed', async () => {
    // **The opposite of `ratelimit`'s default, deliberately.** Proceeding
    // without a claim double-applies the write the client asked to have
    // protected — a throttle that fails open loses some throttling, and a claim
    // that fails open loses the money.
    let calls = 0;
    const broken: Records = {
      claim: () => Promise.reject(unavailable('connection refused')),
      complete: () => Promise.resolve(),
      consume: () => Promise.resolve(),
      release: () => Promise.resolve(),
      purge: () => Promise.resolve(0),
    };

    const call = callable(
      () => {
        calls += 1;
        return Promise.resolve(json(201, {}));
      },
      { records: broken },
    );

    const response = await call(withKey('k11'));

    expect(response.status).toBe(503);
    // The handler never ran. That is the whole property.
    expect(calls).toBe(0);
  });

  it('logs when it fires, because I9 requires the choice to be visible', async () => {
    const lines: string[] = [];
    const broken: Records = {
      claim: () => Promise.reject(unavailable('connection refused')),
      complete: () => Promise.resolve(),
      consume: () => Promise.resolve(),
      release: () => Promise.resolve(),
      purge: () => Promise.resolve(0),
    };

    const call = callable(counting(), {
      records: broken,
      reporter: { info: () => undefined, error: (m) => lines.push(m) },
    });

    await call(withKey('k12'));

    // A 503 nobody can attribute to the idempotency store looks like the
    // database being down, and the operator goes and looks at the wrong thing.
    expect(lines.join(' ')).toContain('failing closed');
  });

  it('does NOT fail the request when only the store-after step fails', async () => {
    // The asymmetry with `claim` is the point: failing here would deny an
    // execution that already happened and whose writes are already durable.
    const lines: string[] = [];
    const halfBroken: Records = {
      ...memoryRecords(clock),
      complete: () => Promise.reject(internal('disk full')),
    };

    const call = callable(counting(), {
      records: halfBroken,
      reporter: { info: () => undefined, error: (m) => lines.push(m) },
    });

    const response = await call(withKey('k13'));

    expect(response.status).toBe(201);
    expect(lines.join(' ')).toContain('could not be stored');
  });
});

describe('what is stored, and what is not', () => {
  it('keeps headers the response owns', () => {
    expect(
      storableHeaders({
        'content-type': 'application/json',
        etag: 'W/"1"',
        location: '/payments/1',
      }),
    ).toEqual({
      'content-type': 'application/json',
      etag: 'W/"1"',
      location: '/payments/1',
    });
  });

  it('drops per-request headers, which would be a lie on replay', () => {
    expect(
      storableHeaders({
        'x-request-id': '01a0-first-request',
        'x-correlation-id': 'corr-1',
        date: 'Mon, 01 Jan 2026 00:00:00 GMT',
        'set-cookie': 'session=abc',
        'content-type': 'application/json',
      }),
    ).toEqual({ 'content-type': 'application/json' });
  });

  it('never replays a per-request header the handler set', async () => {
    // **The one that matters.** `set-cookie` is per-session by definition, so a
    // replayed one hands a second caller the first caller's session. Asserting
    // `storableHeaders` in isolation does not prove the middleware calls it.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.resolve({
        status: 201,
        headers: {
          'content-type': 'application/json',
          'set-cookie': `session=first-caller-${String(calls)}`,
          date: 'Mon, 01 Jan 2026 00:00:00 GMT',
        },
        body: '{"ok":true}',
      });
    });

    const first = await call(withKey('k18'));
    const second = await call(withKey('k18'));

    expect(first.headers['set-cookie']).toBe('session=first-caller-1');
    expect(second.headers[REPLAY_HEADER]).toBe('true');
    expect(second.headers['set-cookie']).toBeUndefined();
    expect(second.headers['date']).toBeUndefined();
    // And what the response genuinely owns is still there.
    expect(second.headers['content-type']).toBe('application/json');
  });

  it('gives a replay the CURRENT request`s id, not the stored one', async () => {
    const call = callable(counting());

    const first = await call(withKey('k14'));
    const second = await call(withKey('k14'));

    expect(second.body).toBe(first.body);
    // Same response, different exchange. Position 1 stamps the replay with the
    // id of the request that is actually being answered.
    expect(second.headers['x-request-id']).not.toBe(
      first.headers['x-request-id'],
    );
  });

  it('passes the response through past the cap, and says so loudly', async () => {
    // A wiring mistake, not a runtime condition: a response this large means an
    // endpoint that should never have accepted a key. But the response is a
    // real answer to a real request, and a 500 would tell the client its write
    // failed when it did not — so it goes through and the log carries the
    // problem. Silently skipping the store is the failure mode: the client
    // believes it is protected and nothing anywhere says otherwise.
    const lines: string[] = [];
    const call = callable(
      () => Promise.resolve(text(200, 'x'.repeat(MAX_STORED_BYTES + 1))),
      { reporter: { info: () => undefined, error: (m) => lines.push(m) } },
    );

    const response = await call(withKey('k15'));

    expect(response.status).toBe(200);
    expect(lines.join(' ')).toContain('must not accept a key');
  });

  it('spends the key past the cap rather than releasing it', async () => {
    // **Losing replay is a cost; losing the guarantee is a failure.** Released,
    // the retry re-executes and double-applies the write the key was sent to
    // protect. Consumed, the retry gets a definitive answer.
    let calls = 0;
    const call = callable(() => {
      calls += 1;
      return Promise.resolve(text(200, 'x'.repeat(MAX_STORED_BYTES + 1)));
    });

    await call(withKey('k16'));
    const second = await call(withKey('k16'));

    // 422 rather than 409: the work happened and the answer is gone, so
    // "come back later" would promise a reply that is never coming.
    expect(second.status).toBe(422);
    expect((JSON.parse(second.body) as { detail: string }).detail).toContain(
      'cannot be replayed',
    );
    expect(calls).toBe(1);
  });
});

describe('requests the module leaves alone', () => {
  it('ignores a request with no key', async () => {
    const call = callable(counting());

    const first = await call();
    const second = await call();

    expect(JSON.parse(first.body)).toEqual({ call: 1 });
    expect(JSON.parse(second.body)).toEqual({ call: 2 });
  });

  it('ignores a key on a safe method', async () => {
    // Harmlessly thorough client libraries attach the header to everything.
    // There is no state to protect, so ignoring beats refusing.
    const call = callable(counting());

    const first = await call(withKey('k17', { method: 'GET' }));
    const second = await call(withKey('k17', { method: 'GET' }));

    expect(JSON.parse(second.body)).toEqual({ call: 2 });
    expect(first.headers[REPLAY_HEADER]).toBeUndefined();
  });

  it('refuses an empty key rather than treating it as absent', async () => {
    const call = callable(counting());

    const response = await call(withKey(''));

    expect(response.status).toBe(400);
  });
});

describe('the 422 refinement', () => {
  it('leaves an ordinary invalid at 400', async () => {
    const call = callable(() => Promise.reject(invalid('bad request')));

    const response = await call();

    expect(response.status).toBe(400);
    expect((JSON.parse(response.body) as { type: string }).type).toBe(
      '/problems/invalid',
    );
  });
});
