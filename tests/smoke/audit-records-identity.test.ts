/**
 * `audit` records `identity`, end to end. **Conformance cases 34–38.**
 *
 * **The proof that the event plumbing works**, and the first test in this
 * repository where two contexts are wired together — through the bus, never
 * through an import. `identity` publishes; `audit` records; neither knows the
 * other exists.
 *
 * **It lives in `tests/smoke/` because rule `S6` put it here.** Written first
 * as `src/contexts/audit/index.test.ts`, it tripped *contexts never import each
 * other* — and the rule was right: **a test that wires two contexts is a
 * composition-root test**, not a context's own. `S6` exempts no test file, and
 * that turns out to be the correct strictness rather than an oversight, because
 * the exemption would have let a context's own suite reach for a peer.
 *
 * Rung 0, like the other smoke test: no Docker, no network, no build. A unit
 * test proves a module works; this proves the graph can be built at all.
 *
 * Everything asserted about a record arrived on an event. Where an assertion
 * needs a field the event does not carry, the **event** is what changes.
 */

import { describe, expect, it } from 'vitest';
import {
  type Subject,
  Scope,
  compilePolicy,
  makeAuthorizer,
  subject,
} from '../../src/shared/authz/index.js';
import { fakeClock, millis, seconds } from '../../src/shared/clock/index.js';
import {
  type Exchange,
  type Request,
  type Response,
} from '../../src/shared/edge/index.js';
import { memoryEvents } from '../../src/shared/events/index.js';
import { chain } from '../../src/shared/httpx/index.js';
import { fakeIds } from '../../src/shared/id/index.js';
import { makeOrigins } from '../../src/shared/provenance/index.js';
import { fakeRandom } from '../../src/shared/random/index.js';
import { unwrap } from '../../src/shared/result/index.js';
import { memoryTelemetry } from '../../src/shared/telemetry/index.js';
import {
  type ChallengeMailer,
  type Hasher,
} from '../../src/contexts/identity/app/ports.js';
import {
  passwordHash,
  role,
  userId,
} from '../../src/contexts/identity/domain/index.js';
import { makeIdentity } from '../../src/contexts/identity/index.js';
import {
  GRANT_ROLE,
  REVOKE_ROLE,
} from '../../src/contexts/identity/app/command/roles.js';
import { makeAudit, READ_RECORDS } from '../../src/contexts/audit/index.js';

/**
 * A composition root, in miniature.
 *
 * This is the only place both contexts appear, which is rule `S5`/`S6` working
 * as intended: **a test that wires them is a root**, and a root is allowed to
 * see both.
 */
function wire() {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const bus = memoryEvents({ clock, ids });

  const hasher: Hasher = {
    hash: (password) =>
      Promise.resolve(passwordHash(`fake:${password.reveal()}`)),
    verify: (stored, password) =>
      Promise.resolve(stored === `fake:${password.reveal()}`),
    dummy: passwordHash('fake:$$nothing'),
    // The fake is always at policy; the real hasher's own tests cover the
    // downgrade path against the collection fixture.
    needsRehash: () => false,
  };
  const mailer: ChallengeMailer = { send: () => Promise.resolve() };

  // **One policy, both contexts**, compiled by the root and injected into each.
  // `admin` and `auditor` read everything; everybody else reads their own —
  // §3 — and that is what lets `audit` honour the rule without ever knowing
  // the name `admin` exists.
  const policy = unwrap(
    compilePolicy({
      admin: [
        { action: READ_RECORDS, scope: Scope.Any },
        { action: GRANT_ROLE, scope: Scope.Any },
        { action: REVOKE_ROLE, scope: Scope.Any },
      ],
      auditor: [{ action: READ_RECORDS, scope: Scope.Any }],
      member: [{ action: READ_RECORDS, scope: Scope.Own }],
    }),
  );
  const authorizer = makeAuthorizer(policy);

  const identity = makeIdentity({
    clock,
    ids,
    random: fakeRandom(1),
    telemetry: memoryTelemetry(clock),
    publisher: bus,
    hasher,
    mailer,
    authorizer,
    sessionTtlMs: seconds(3600),
  });

  /**
   * **The root lends `audit` identity's bearer auth** — §3.
   *
   * Position 6 already authenticated and set the actor on the provenance, so
   * this reads it from there rather than resolving a token a second time.
   */
  const caller = (exchange: Exchange): Subject | undefined => {
    const actor = exchange.provenance.actor;
    if (actor.kind === 'anonymous') return undefined;
    return subject({
      actor,
      roles: [...roles],
      tenant: 'default',
    });
  };

  // Set by a test before it reads; the root would take these from the caller's
  // own user, which `identity` supplies and `audit` never sees.
  let roles: readonly string[] = ['member'];

  const audit = makeAudit({ clock, ids, authorizer, caller });
  bus.subscribe(audit.subscription);

  const identityHandler = chain(
    {
      clock,
      origins: makeOrigins(ids),
      telemetry: memoryTelemetry(clock),
      authenticate: identity.authenticate,
    },
    identity.handler,
  );

  const auditHandler = chain(
    {
      clock,
      origins: makeOrigins(ids),
      telemetry: memoryTelemetry(clock),
      // The **same** authenticator, lent across the boundary.
      authenticate: identity.authenticate,
    },
    audit.handler,
  );

  const call = (
    handler: typeof identityHandler,
    over: Partial<Request> = {},
  ): Promise<Response> => {
    const request: Request = {
      method: 'GET',
      path: '/v1/me',
      query: {},
      headers: {},
      peer: '127.0.0.1',
      body: () => Promise.resolve(''),
      ...over,
    };
    return handler({
      request,
      responseHeaders: {},
      remaining: () => millis(30_000),
    } as Exchange);
  };

  return {
    clock,
    bus,
    identity,
    audit,
    setRoles: (next: readonly string[]) => {
      roles = next;
    },
    identityCall: (over?: Partial<Request>) => call(identityHandler, over),
    auditCall: (over?: Partial<Request>) => call(auditHandler, over),
  };
}

type Harness = ReturnType<typeof wire>;

/** Narrow, and fail at the read rather than blaming the next line. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

const post = (
  path: string,
  body: unknown,
  token?: string,
): Partial<Request> => ({
  method: 'POST',
  path,
  body: () => Promise.resolve(JSON.stringify(body)),
  headers: {
    'content-type': 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
  },
});

async function signUp(h: Harness, address: string) {
  const created = await h.identityCall(
    post('/v1/users', {
      email: address,
      password: 'correct-horse-battery',
    }),
  );
  expect(created.status).toBe(201);

  const loggedIn = await h.identityCall(
    post('/v1/sessions', {
      email: address,
      password: 'correct-horse-battery',
    }),
  );
  expect(loggedIn.status).toBe(201);

  const body = JSON.parse(loggedIn.body) as {
    access_token: string;
    user_id: string;
  };
  return { token: body.access_token, userId: body.user_id };
}

/** Deliver whatever the bus is holding. */
async function drain(h: Harness): Promise<void> {
  await h.bus.dispatcher.drain();
}

const records = (h: Harness) => [...(h.audit.store?.records ?? [])];

describe('case 34 — every mutation produces a named domain event', () => {
  it('records identity`s events without importing identity', async () => {
    const h = wire();
    await signUp(h, 'ada@example.com');
    await drain(h);

    const names = records(h).map((r) => r.state.event);

    expect(names).toContain('identity.user.registered');
    expect(names).toContain('identity.session.created');
    expect(names).toContain('identity.user.authenticated');
    // `<context>.<entity>.<verb>`, every one.
    for (const name of names) {
      expect(name).toMatch(
        /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/,
      );
    }
  });
});

describe('case 35 — every event carries the provenance shape', () => {
  it('records request, correlation, actor and tenant from the envelope', async () => {
    const h = wire();
    const { userId } = await signUp(h, 'ada@example.com');
    await drain(h);

    const registered = records(h).find(
      (r) => r.state.event === 'identity.user.registered',
    );

    expect(registered?.state.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(registered?.state.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    // Registration is anonymous, and the record says so rather than guessing.
    expect(registered?.state.actor).toBe('anonymous:');
    // The **subject** came off the payload, which is the only place `audit`
    // could have got it — it cannot look a user up.
    expect(registered?.state.subject).toBe(userId);
  });

  it('records an actor that is NOT the subject, which is the case that matters', async () => {
    // §2.5: subject and actor differ more often than they look. An
    // administrator acting on somebody else is the case a record assuming them
    // equal gets wrong.
    const h = wire();
    const admin = await signUp(h, 'admin@example.com');
    const target = await signUp(h, 'ada@example.com');
    await drain(h);

    // Grant through the domain, the way the first administrator is seeded.
    const user = present(
      await h.identity.deps.users.byId(userId(admin.userId)),
      'the administrator',
    );
    user.grantRole(role('admin'), h.clock.now());
    await h.identity.deps.transactor.within((work) => work.users.save(user));

    // Now an authorized grant, over HTTP, by the administrator.
    await h.identityCall(
      post(
        `/v1/users/${target.userId}/roles`,
        { role: 'auditor' },
        admin.token,
      ),
    );
    await drain(h);

    const granted = records(h).find(
      (r) => r.state.event === 'identity.user.role_granted',
    );

    // The record answers *who did what to whom* — both halves, from the event.
    expect(granted?.state.subject).toBe(target.userId);
    expect(granted?.state.actor).toBe(`user:${admin.userId}`);
    expect(granted?.state.actor).not.toBe(granted?.state.subject);
  });
});

describe('case 36 — idempotent by event id', () => {
  it('a redelivered event adds no row', async () => {
    const h = wire();
    await signUp(h, 'ada@example.com');
    await drain(h);

    const before = records(h).length;
    expect(before).toBeGreaterThan(0);

    // Deliver everything again. The memory bus dedupes per subscriber, so this
    // exercises `audit`'s own constraint by replaying the envelopes directly.
    for (const envelope of h.bus.published()) {
      await h.audit.subscription.handle(envelope);
    }

    expect(records(h)).toHaveLength(before);
  });

  it('is keyed on the EVENT id, not on a record id the subscriber minted', async () => {
    // Each redelivery mints a fresh record id, so keying on that would store
    // every redelivery and case 36 would pass only because nothing redelivered.
    const h = wire();
    await signUp(h, 'ada@example.com');
    await drain(h);

    const first = present(records(h)[0], 'a record');
    const envelope = present(
      h.bus.published().find((e) => e.id === first.state.eventId),
      'the envelope',
    );

    await h.audit.subscription.handle(envelope);
    await h.audit.subscription.handle(envelope);

    expect(
      records(h).filter((r) => r.state.eventId === first.state.eventId),
    ).toHaveLength(1);
  });
});

describe('case 38 — correlation survives the boundary', () => {
  it('the record carries the ORIGINATING request`s correlation id', async () => {
    // **The subscriber derives, never mints.** `provenanceFor(envelope)` is
    // `envelope.provenance.derive(envelope.id)`: a fresh request id for this
    // unit of work, the envelope's correlation carried through. A subscriber
    // calling `forJob` would mint a new correlation and break the chain at
    // exactly the point `audit` exists to record.
    const h = wire();
    const correlation = 'corr-from-the-client';

    await h.identityCall({
      ...post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlation,
      },
    });
    await drain(h);

    const registered = records(h).find(
      (r) => r.state.event === 'identity.user.registered',
    );

    expect(registered?.state.correlationId).toBe(correlation);
  });

  it('groups every event of one request under one correlation', async () => {
    // The property that makes the log usable: a login produces two events, and
    // both reconstruct to the same request.
    const h = wire();
    await signUp(h, 'ada@example.com');
    const correlation = 'corr-for-the-login';

    await h.identityCall({
      ...post('/v1/sessions', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
      headers: {
        'content-type': 'application/json',
        'x-correlation-id': correlation,
      },
    });
    await drain(h);

    const mine = records(h).filter(
      (r) => r.state.correlationId === correlation,
    );

    expect(mine.map((r) => r.state.event).sort()).toEqual([
      'identity.session.created',
      'identity.user.authenticated',
    ]);
  });

  it('records the ORIGINATING request id, not the subscriber`s', async () => {
    // The derived provenance has a *new* request id — this is a new unit of
    // work — and the record keeps the one the event came from, which is what a
    // reader joins against an access log.
    const h = wire();
    await signUp(h, 'ada@example.com');
    await drain(h);

    const registered = records(h).find(
      (r) => r.state.event === 'identity.user.registered',
    );
    const envelope = h.bus
      .published()
      .find((e) => e.name === 'identity.user.registered');

    expect(registered?.state.requestId).toBe(envelope?.provenance.requestId);
  });
});

describe('case 37 — reads are policy-scoped', () => {
  async function read(
    h: Harness,
    token: string,
    query = '',
  ): Promise<Response> {
    return h.auditCall({
      method: 'GET',
      path: '/v1/audit',
      query: Object.fromEntries(new URLSearchParams(query)),
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('a member reads records where they are the actor or the subject', async () => {
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    await signUp(h, 'somebody@example.com');
    await drain(h);

    const response = await read(h, me.token);

    expect(response.status).toBe(200);
    const found = JSON.parse(response.body) as {
      actor: string;
      subject?: string;
    }[];
    expect(found.length).toBeGreaterThan(0);
    for (const record of found) {
      expect(
        record.actor === `user:${me.userId}` || record.subject === me.userId,
      ).toBe(true);
    }
  });

  it('and none of somebody else`s', async () => {
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    const them = await signUp(h, 'somebody@example.com');
    await drain(h);

    const found = JSON.parse((await read(h, me.token)).body) as {
      subject?: string;
    }[];

    expect(found.map((r) => r.subject)).not.toContain(them.userId);
  });

  it('an auditor reads everything', async () => {
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    const them = await signUp(h, 'somebody@example.com');
    await drain(h);

    h.setRoles(['auditor']);
    const found = JSON.parse((await read(h, me.token, 'limit=200')).body) as {
      subject?: string;
    }[];

    expect(found.map((r) => r.subject)).toContain(them.userId);
  });

  it('a caller cannot widen their reach with a filter', async () => {
    // **The escalation the scope exists to prevent.** Narrowing to somebody
    // else's id must still return nothing, because the scope is ANDed rather
    // than defaulted.
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    const them = await signUp(h, 'somebody@example.com');
    await drain(h);

    const found = JSON.parse(
      (await read(h, me.token, `subject=${them.userId}`)).body,
    ) as unknown[];

    expect(found).toEqual([]);
  });

  it('is 403 for a caller the policy does not permit', async () => {
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    await drain(h);

    h.setRoles(['nobody']);

    expect((await read(h, me.token)).status).toBe(403);
  });

  it('is 401 without a token', async () => {
    const h = wire();

    const response = await h.auditCall({
      method: 'GET',
      path: '/v1/audit',
    });

    expect(response.status).toBe(401);
  });
});

describe('querying — §3', () => {
  async function read(h: Harness, token: string, query: string) {
    const response = await h.auditCall({
      method: 'GET',
      path: '/v1/audit',
      query: Object.fromEntries(new URLSearchParams(query)),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    return JSON.parse(response.body) as { event: string }[];
  }

  it('filters by event prefix, with the dot as the boundary', async () => {
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    await drain(h);
    h.setRoles(['auditor']);

    const users = await read(h, me.token, 'prefix=identity.user.&limit=200');
    const all = await read(h, me.token, 'prefix=identity.&limit=200');

    expect(users.every((r) => r.event.startsWith('identity.user.'))).toBe(true);
    expect(all.map((r) => r.event)).toContain('identity.session.created');
    expect(users.map((r) => r.event)).not.toContain('identity.session.created');
  });

  it('refuses a prefix carrying a `like` wildcard', async () => {
    const h = wire();
    const me = await signUp(h, 'ada@example.com');
    await drain(h);

    const response = await h.auditCall({
      method: 'GET',
      path: '/v1/audit',
      query: { prefix: '%' },
      headers: { authorization: `Bearer ${me.token}` },
    });

    expect(response.status).toBe(400);
  });
});
