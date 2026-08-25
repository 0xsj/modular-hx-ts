/**
 * `identity` end to end. **Conformance cases 5–11.**
 *
 * Through the **real chain** — provenance, the problem mapper, authn, the route
 * registry — because that is where the cases are actually specified. A test
 * that called the command directly would prove the command works and say
 * nothing about the status, the body or the token the case names.
 */

import { describe, expect, it } from 'vitest';
import { fakeClock, millis, seconds } from '../../shared/clock/index.js';
import { conditional } from '../../shared/conditional/index.js';
import {
  type Exchange,
  type Request,
  type Response,
} from '../../shared/edge/index.js';
import { memoryEvents, type MemoryEvents } from '../../shared/events/index.js';
import { chain } from '../../shared/httpx/index.js';
import { fakeIds } from '../../shared/id/index.js';
import { makeOrigins } from '../../shared/provenance/index.js';
import { fakeRandom } from '../../shared/random/index.js';
import { unwrap } from '../../shared/result/index.js';
import { type Subject, subject } from '../../shared/authz/index.js';
import { Actor } from '../../shared/provenance/index.js';
import { memoryTelemetry } from '../../shared/telemetry/index.js';
import { type Identity, type IdentityOptions, makeIdentity } from './index.js';
import {
  Scope,
  compilePolicy,
  makeAuthorizer,
} from '../../shared/authz/index.js';
import { GRANT_ROLE, REVOKE_ROLE } from './app/command/roles.js';
import { type ChallengeMailer, type Hasher } from './app/ports.js';
import { subjectOf } from './transport/http/routes.js';
import {
  ApiKey,
  apiKeyId,
  passwordHash,
  role,
  userId,
} from './domain/index.js';

/**
 * A hasher that is not memory-hard.
 *
 * scrypt at OWASP parameters takes ~100ms per call by design, and this file
 * makes dozens of calls. The **real** hasher has its own test; here the port is
 * the thing being exercised, and its timing property is asserted separately
 * against the real one.
 */
interface CountingHasher extends Hasher {
  /** How many times `verify` has been called. The timing proxy; see case 7. */
  verifications(): number;
}

function fastHasher(): CountingHasher {
  let verifications = 0;
  return {
    hash: (password) =>
      Promise.resolve(passwordHash(`fake:${password.reveal()}`)),
    verify: (stored, password) => {
      verifications += 1;
      return Promise.resolve(stored === `fake:${password.reveal()}`);
    },
    // A value no real hash can equal. Spelled without a control character:
    // this line held a raw NUL when it was written, which renders as a space,
    // survives `grep`, and is caught only by `tests/rules/encoding.test.ts`.
    dummy: passwordHash('fake:$$no-such-password'),
    // The fake is always at policy; the real hasher's own tests cover the
    // downgrade path against the collection fixture.
    needsRehash: () => false,
    verifications: () => verifications,
  };
}

/** Every link this harness "sent", so a test can hold the secret. */
interface Sent {
  readonly to: string;
  readonly purpose: string;
  readonly secret: string;
  readonly payload: string;
}

function recordingMailer(): ChallengeMailer & { sent: () => readonly Sent[] } {
  const sent: Sent[] = [];
  return {
    send: (to, purpose, secret, payload) => {
      sent.push({ to, purpose, secret, payload });
      return Promise.resolve();
    },
    sent: () => sent,
  };
}

interface Harness {
  readonly identity: Identity;
  readonly events: MemoryEvents;
  readonly hasher: CountingHasher;
  readonly mail: ReturnType<typeof recordingMailer>;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly call: (over?: Partial<Request>) => Promise<Response>;
}

function harness(over: Partial<IdentityOptions> = {}): Harness {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const events = memoryEvents({ clock, ids });
  const hasher = fastHasher();
  const mail = recordingMailer();

  const identity = makeIdentity({
    clock,
    ids,
    random: fakeRandom(1),
    telemetry: memoryTelemetry(clock),
    publisher: events,
    hasher,
    mailer: mail,
    sessionTtlMs: seconds(3600),
    ...over,
  });

  const built = chain(
    {
      clock,
      origins: makeOrigins(ids),
      telemetry: memoryTelemetry(clock),
      // **Position 6.** Without it the router still works and every event this
      // context publishes names `anonymous:` — see `transport/http/authn.ts`.
      authenticate: identity.authenticate,
      // The context supplies the validator `conditional` has been waiting for.
      conditional: conditional({ validators: identity.validators }),
    },
    identity.handler,
  );

  const call = (over: Partial<Request> = {}): Promise<Response> => {
    const request: Request = {
      method: 'GET',
      path: '/v1/me',
      query: {},
      headers: {},
      peer: '127.0.0.1',
      body: () => Promise.resolve(''),
      ...over,
    };
    return built({
      request,
      responseHeaders: {},
      remaining: () => millis(30_000),
    } as Exchange);
  };

  return { identity, events, hasher, mail, clock, call };
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

const bearer = (token: string): Partial<Request> => ({
  headers: { authorization: `Bearer ${token}` },
});

interface Registered {
  // **camelCase, and deliberately.** Only what crosses the wire is snake — a
  // blanket rename took this with it once, which is the mistake worth leaving a
  // sentence about: the two vocabularies are separate on purpose.
  readonly userId: string;
  readonly token: string;
  readonly sessionId: string;
}

/**
 * Log in, and nothing else.
 *
 * Separate from registration on purpose: conformance case 9 is about **three
 * sessions for one user**, and a helper that registered every time would give
 * three users, three separate session sets, and a case that passed while
 * testing nothing.
 */
async function logIn(
  h: Harness,
  address: string,
  secret = 'correct-horse-battery',
): Promise<Registered> {
  const loggedIn = await h.call(
    post('/v1/sessions', { email: address, password: secret }),
  );
  expect(loggedIn.status).toBe(201);

  const body = JSON.parse(loggedIn.body) as {
    access_token: string;
    session_id: string;
    user_id: string;
  };
  return {
    userId: body.user_id,
    token: body.access_token,
    sessionId: body.session_id,
  };
}

/**
 * Seed a role directly, the way a deployment does.
 *
 * **There is no route that can grant the first administrator**, and that is the
 * design rather than a gap: every role route is authorized, so a caller with no
 * roles cannot grant themselves one. The first admin arrives by migration or by
 * an operator command, not over HTTP — which is what stops the endpoint being a
 * privilege-escalation primitive.
 */
/** Narrow, and fail at the read rather than blaming the next line. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

async function seedRole(
  h: Harness,
  target: string,
  named: string,
): Promise<void> {
  const user = await h.identity.deps.users.byId(userId(target));
  user?.grantRole(role(named), new Date());
  await h.identity.deps.transactor.within((work) =>
    work.users.save(present(user, 'the user')),
  );
}

/** The `Subject` the app would build for this caller, for a case-17 assertion. */
function subjectFor(
  h: Harness,
  who: Registered,
  scopes: readonly string[],
): Subject {
  const user = [...(h.identity.store?.users.values() ?? [])].find(
    (row) => row.id === who.userId,
  );
  return subject({
    actor: unwrap(Actor.user(who.userId)),
    roles: [...(user?.roles ?? [])],
    ...(scopes.length === 0 ? {} : { scopes: [...scopes] }),
    tenant: 'default',
  });
}

/** Grant a role over HTTP, which is the surface case 12 is about. */
function grant(
  h: Harness,
  by: Registered,
  target: string,
  named: string,
): Promise<Response> {
  return h.call(post(`/v1/users/${target}/roles`, { role: named }, by.token));
}

async function signUp(
  h: Harness,
  address: string,
  secret = 'correct-horse-battery',
): Promise<Registered> {
  const created = await h.call(
    post('/v1/users', { email: address, password: secret }),
  );
  expect(created.status).toBe(201);
  return logIn(h, address, secret);
}

describe('case 5 — register creates an active user', () => {
  it('returns its identifier, and the user is enabled', async () => {
    const h = harness();

    const response = await h.call(
      post('/v1/users', {
        email: 'Ada@Example.COM',
        password: 'correct-horse-battery',
      }),
    );

    expect(response.status).toBe(201);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(body['status']).toBe('active');
    // §2.1: the **whole** address is lowercased, not just the domain.
    expect(body['email']).toBe('ada@example.com');
  });

  it('never puts a password or a hash on the wire', async () => {
    const h = harness();

    const response = await h.call(
      post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    expect(response.body).not.toContain('correct-horse');
    expect(response.body).not.toContain('passwordHash');
    expect(response.body).not.toContain('fake:');
  });

  it('refuses a duplicate address with a 409', async () => {
    // The unique index reaching the edge as conformance case 3's Kind→status.
    const h = harness();
    const body = {
      email: 'ada@example.com',
      password: 'correct-horse-battery',
    };

    await h.call(post('/v1/users', body));
    const second = await h.call(post('/v1/users', body));

    expect(second.status).toBe(409);
  });

  it('returns every field problem at once — case 2', async () => {
    const h = harness();

    const response = await h.call(
      post('/v1/users', { email: 42, password: 7 }),
    );

    expect(response.status).toBe(400);
    const problem = JSON.parse(response.body) as {
      errors: Record<string, unknown>;
    };
    expect(Object.keys(problem.errors).sort()).toEqual(['email', 'password']);
  });
});

describe('case 6 — login returns a bearer token', () => {
  it('returns the token, its type, an expiry, and the two ids', async () => {
    const h = harness();
    await h.call(
      post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    const response = await h.call(
      post('/v1/sessions', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    expect(response.status).toBe(201);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(typeof body['access_token']).toBe('string');
    expect(body['token_type']).toBe('Bearer');
    expect(typeof body['expires_at']).toBe('string');
    expect(body['user_id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(body['session_id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores a fingerprint, never the token', async () => {
    // A database dump yields no usable sessions. Asserted against the store
    // rather than trusted.
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const stored = [...(h.identity.store?.sessions.values() ?? [])];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
  });
});

describe('case 7 — no enumeration oracle', () => {
  it('answers a wrong password and an unknown address identically', async () => {
    const h = harness();
    await h.call(
      post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    const wrongPassword = await h.call(
      post('/v1/sessions', {
        email: 'ada@example.com',
        password: 'not-the-password',
      }),
    );
    const unknownAddress = await h.call(
      post('/v1/sessions', {
        email: 'nobody@example.com',
        password: 'not-the-password',
      }),
    );

    // Status **and** body. `instance` is the request id and differs by design.
    expect(unknownAddress.status).toBe(wrongPassword.status);
    expect(strip(unknownAddress.body)).toEqual(strip(wrongPassword.body));
  });

  it('does the SAME hashing work for an unknown address', async () => {
    // **The timing half of case 7, and the half a status-and-body comparison
    // cannot see.** A login that skips verification when the address is
    // unknown returns measurably faster, and an attacker reads that difference
    // off a stopwatch without ever authenticating.
    //
    // **Counted, not timed.** A wall-clock assertion on a memory-hard hash is
    // flaky by construction, and a flaky assertion gets loosened until it
    // asserts nothing or deleted outright. The property is *the same work
    // happens*, and counting the work states it directly.
    const h = harness();
    await h.call(
      post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    const start = h.hasher.verifications();
    await h.call(
      post('/v1/sessions', {
        email: 'ada@example.com',
        password: 'not-the-password',
      }),
    );
    const forWrongPassword = h.hasher.verifications() - start;

    const middle = h.hasher.verifications();
    await h.call(
      post('/v1/sessions', {
        email: 'nobody@example.com',
        password: 'not-the-password',
      }),
    );
    const forUnknownAddress = h.hasher.verifications() - middle;

    expect(forWrongPassword).toBe(1);
    expect(forUnknownAddress).toBe(forWrongPassword);
  });

  it('does the same work for a malformed address too', async () => {
    // The path that never reaches a lookup still pays for one verification.
    const h = harness();

    const start = h.hasher.verifications();
    await h.call(
      post('/v1/sessions', {
        email: 'not-an-address',
        password: 'correct-horse-battery',
      }),
    );

    expect(h.hasher.verifications() - start).toBe(1);
  });

  it('answers a MALFORMED address the same way too', async () => {
    // The oracle wearing a different status code: 400 for "not an address" and
    // 401 for "wrong password" tells an attacker which addresses are shaped
    // like real ones this system would accept.
    const h = harness();

    const malformed = await h.call(
      post('/v1/sessions', {
        email: 'not-an-address',
        password: 'x'.repeat(12),
      }),
    );

    expect(malformed.status).toBe(401);
  });

  it('answers a too-short password the same way too', async () => {
    const h = harness();
    await h.call(
      post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    const short = await h.call(
      post('/v1/sessions', { email: 'ada@example.com', password: 'x' }),
    );

    expect(short.status).toBe(401);
  });

  it('keeps an unknown address OFF the bus — §2.2', async () => {
    // `AuthenticationFailed` fires only for existing users. Publishing an
    // unknown address writes an attacker's guesses into `audit`.
    const h = harness();

    await h.call(
      post('/v1/sessions', {
        email: 'nobody@example.com',
        password: 'not-the-password',
      }),
    );

    expect(h.events.published().map((envelope) => envelope.name)).not.toContain(
      'identity.user.authentication_failed',
    );
  });

  it('DOES record a failure for a user who exists', async () => {
    const h = harness();
    await h.call(
      post('/v1/users', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );

    await h.call(
      post('/v1/sessions', {
        email: 'ada@example.com',
        password: 'not-the-password',
      }),
    );

    const failure = h.events
      .published()
      .find((e) => e.name === 'identity.user.authentication_failed');
    expect(failure?.payload['reason']).toBe('bad_password');
  });
});

describe('case 8 — GET /me', () => {
  it('returns the caller with the token', async () => {
    const h = harness();
    const { token, userId } = await signUp(h, 'ada@example.com');

    const response = await h.call(bearer(token));

    expect(response.status).toBe(200);
    expect((JSON.parse(response.body) as { id: string }).id).toBe(userId);
  });

  it('is 401 without one', async () => {
    const h = harness();

    expect((await h.call()).status).toBe(401);
  });

  it('is 401 with a fabricated one', async () => {
    const h = harness();
    await signUp(h, 'ada@example.com');

    expect((await h.call(bearer('not-a-real-token'))).status).toBe(401);
  });

  it('carries an ETag — case 30, and `conditional`s first implementer', async () => {
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const response = await h.call(bearer(token));

    expect(response.headers['etag']).toMatch(/^"sha256:[0-9a-f]{64}"$/);
  });

  it('does not move on a login — but that proves nothing HERE, and says so', async () => {
    // **The correction in the collection's §3.** The instance was *every login
    // appends, so signing in invalidates everybody's cached view* — true where
    // the store is a log, false where it is a row. Here `Session` is a separate
    // aggregate (§2.2) and `issue` never touches the user row, so a
    // version-derived tag would pass this too.
    //
    // Kept as a **regression guard**, not as evidence: it fails the day
    // somebody folds sessions into `User`, which is the change that would make
    // the original instance real here. It is not the probe that distinguishes a
    // representation tag from a counter — that is the variant test below.
    const h = harness();
    const first = await signUp(h, 'ada@example.com');

    const before = (await h.call(bearer(first.token))).headers['etag'];
    const second = await logIn(h, 'ada@example.com');
    const after = (await h.call(bearer(second.token))).headers['etag'];

    expect(after).toBe(before);
  });

  it('gives ONE user at ONE version two tags, for two variants', async () => {
    // **This is the probe a counter cannot pass.** A version is an identity for
    // the *entity*; an ETag is an identity for the *representation*, and one
    // entity at one version has as many representations as it has variants.
    // `User.version` is a single number and cannot answer for two of them.
    //
    // Nothing else in this suite would fail if the tag were `"v${version}"`.
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const json = await h.call({
      ...bearer(token),
      headers: {
        ...bearer(token).headers,
        accept: 'application/json',
      },
    });
    const other = await h.call({
      ...bearer(token),
      headers: {
        ...bearer(token).headers,
        accept: 'application/vnd.example+json',
      },
    });

    expect(json.status).toBe(200);
    expect(other.status).toBe(200);
    expect(other.headers['etag']).not.toBe(json.headers['etag']);
  });

  it('DOES change on a password change — §3`s corrected instance', async () => {
    // The instance §3 replaced the login with, and the one that is real here: a
    // password change bumps the version and the password is **not in the view
    // it invalidates**. The tag moves anyway, and legitimately — `updatedAt` is
    // rendered, so the bytes a client cached are genuinely stale.
    //
    // Worth stating because it is the case that *looks* like the bug and is
    // not. A tag that never moved would be worse than one that moves too often.
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const before = (await h.call(bearer(token))).headers['etag'];
    await h.call(
      post(
        '/v1/me/password',
        {
          current_password: 'correct-horse-battery',
          new_password: 'a-brand-new-secret',
        },
        token,
      ),
    );
    const after = (await h.call(bearer(token))).headers['etag'];

    expect(after).not.toBe(before);
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const first = await h.call(bearer(token));
    const second = await h.call({
      headers: {
        authorization: `Bearer ${token}`,
        'if-none-match': first.headers['etag'] ?? '',
      },
    });

    expect(second.status).toBe(304);
    expect(second.body).toBe('');
  });
});

describe('case 9 — changing the password', () => {
  it('revokes every OTHER session and leaves the current one live', async () => {
    const h = harness();
    // One user, three sessions — three devices, which is what the case is about.
    const first = await signUp(h, 'ada@example.com');
    const second = await logIn(h, 'ada@example.com');
    const third = await logIn(h, 'ada@example.com');

    const changed = await h.call(
      post(
        '/v1/me/password',
        {
          current_password: 'correct-horse-battery',
          new_password: 'a-brand-new-secret',
        },
        second.token,
      ),
    );

    expect(changed.status).toBe(200);
    expect(
      (JSON.parse(changed.body) as { revokedSessions: number }).revokedSessions,
    ).toBe(2);

    // The one that did the changing still works.
    expect((await h.call(bearer(second.token))).status).toBe(200);
    // The others do not.
    expect((await h.call(bearer(first.token))).status).toBe(401);
    expect((await h.call(bearer(third.token))).status).toBe(401);
  });

  it('refuses without the current password', async () => {
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const response = await h.call(
      post(
        '/v1/me/password',
        {
          current_password: 'not-the-password',
          new_password: 'a-brand-new-secret',
        },
        token,
      ),
    );

    // A stolen session must not become a stolen account.
    expect(response.status).toBe(401);
  });

  it('makes the new password the one that works', async () => {
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    await h.call(
      post(
        '/v1/me/password',
        {
          current_password: 'correct-horse-battery',
          new_password: 'a-brand-new-secret',
        },
        token,
      ),
    );

    expect(
      (
        await h.call(
          post('/v1/sessions', {
            email: 'ada@example.com',
            password: 'a-brand-new-secret',
          }),
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await h.call(
          post('/v1/sessions', {
            email: 'ada@example.com',
            password: 'correct-horse-battery',
          }),
        )
      ).status,
    ).toBe(401);
  });
});

describe('case 10 — logout', () => {
  it('revokes the current session, and reusing the token is 401', async () => {
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    const out = await h.call({
      method: 'DELETE',
      path: '/v1/sessions/current',
      ...bearer(token),
    });

    expect(out.status).toBe(204);
    expect((await h.call(bearer(token))).status).toBe(401);
  });

  it('is idempotent, because the second call is a retry', async () => {
    const h = harness();
    const { token } = await signUp(h, 'ada@example.com');

    await h.call({
      method: 'DELETE',
      path: '/v1/sessions/current',
      ...bearer(token),
    });
    // The token is revoked, so the second attempt is refused by authn — which
    // is the honest answer rather than a second 204.
    const again = await h.call({
      method: 'DELETE',
      path: '/v1/sessions/current',
      ...bearer(token),
    });

    expect(again.status).toBe(401);
  });
});

describe('case 11 — a disabled user', () => {
  it('cannot authenticate, and existing sessions stop working', async () => {
    const h = harness();
    const { token, userId } = await signUp(h, 'ada@example.com');

    // Disabled through the domain: the administrative route lands in slice 2,
    // and the case is about the *effect*, which is already enforceable.
    const user = await h.identity.deps.users.byId(userId as never);
    user?.disable(new Date());
    await h.identity.deps.transactor.within((work) =>
      work.users.save(present(user, 'the user')),
    );

    // The live session stops working — checked per request, so there is no
    // sweep to race with a login in flight.
    expect((await h.call(bearer(token))).status).toBe(401);

    // And a fresh login is refused, with the same message as a wrong password.
    const login = await h.call(
      post('/v1/sessions', {
        email: 'ada@example.com',
        password: 'correct-horse-battery',
      }),
    );
    expect(login.status).toBe(401);
  });
});

describe('case 12 — roles take effect on the NEXT request', () => {
  /** A policy that lets an `admin` manage roles, compiled at wiring time. */
  const adminPolicy = unwrap(
    compilePolicy({
      admin: [
        { action: GRANT_ROLE, scope: Scope.Any },
        { action: REVOKE_ROLE, scope: Scope.Any },
      ],
    }),
  );

  it('is visible on the very next request, with no reissued token', async () => {
    // **The property §2.2 bought by choosing revocation over JWT.** The session
    // carries no roles, so there is no token to reissue and no cache to
    // invalidate — `resolveCaller` reads them fresh every time.
    const h = harness({ authorizer: makeAuthorizer(adminPolicy) });

    const admin = await signUp(h, 'admin@example.com');
    await seedRole(h, admin.userId, 'admin');

    const target = await signUp(h, 'ada@example.com');
    // Before: the view says no roles.
    expect(
      (
        JSON.parse((await h.call(bearer(target.token))).body) as {
          roles: string[];
        }
      ).roles,
    ).toEqual([]);

    const granted = await grant(h, admin, target.userId, 'auditor');
    expect(granted.status).toBe(200);

    // After: **the same token**, the next request, the new role.
    const after = JSON.parse((await h.call(bearer(target.token))).body) as {
      roles: string[];
    };
    expect(after.roles).toEqual(['auditor']);
  });

  it('is 403 for a caller the policy does not permit — case 18', async () => {
    const h = harness({ authorizer: makeAuthorizer(adminPolicy) });
    const nobody = await signUp(h, 'nobody@example.com');
    const target = await signUp(h, 'ada@example.com');

    expect((await grant(h, nobody, target.userId, 'auditor')).status).toBe(403);
  });

  it('is 403 by default, because an unwired policy denies', async () => {
    // `denyAll` is the authorizer when the root wires none — not a placeholder
    // to replace later, the safe default.
    const h = harness();
    const admin = await signUp(h, 'admin@example.com');
    const target = await signUp(h, 'ada@example.com');

    expect((await grant(h, admin, target.userId, 'auditor')).status).toBe(403);
  });

  it('revokes, and that is visible on the next request too', async () => {
    const h = harness({ authorizer: makeAuthorizer(adminPolicy) });
    const admin = await signUp(h, 'admin@example.com');
    await seedRole(h, admin.userId, 'admin');
    const target = await signUp(h, 'ada@example.com');

    await grant(h, admin, target.userId, 'auditor');
    const removed = await h.call({
      method: 'DELETE',
      path: `/v1/users/${target.userId}/roles/auditor`,
      ...bearer(admin.token),
    });

    expect(removed.status).toBe(200);
    expect(
      (
        JSON.parse((await h.call(bearer(target.token))).body) as {
          roles: string[];
        }
      ).roles,
    ).toEqual([]);
  });

  it('names the SUBJECT in the payload and the actor on the envelope', async () => {
    // §2.5's case that matters: an administrator acting on somebody else is
    // exactly where assuming subject and actor are equal goes wrong.
    const h = harness({ authorizer: makeAuthorizer(adminPolicy) });
    const admin = await signUp(h, 'admin@example.com');
    await seedRole(h, admin.userId, 'admin');
    const target = await signUp(h, 'ada@example.com');

    await grant(h, admin, target.userId, 'auditor');

    const event = h.events
      .published()
      .find(
        (e) =>
          e.name === 'identity.user.role_granted' &&
          e.payload['subject'] === target.userId,
      );

    expect(event?.payload['subject']).toBe(target.userId);
    expect(event?.provenance.actor.toString()).toBe(`user:${admin.userId}`);
  });
});

describe('cases 13-15 — emailed links', () => {
  // One route now — `CONFORMANCE.md` §3.5 — with the purpose in the body. The
  // slug survives here as the test's own vocabulary and is mapped at the call.
  const PURPOSE = {
    'verify-email': 'verify_email',
    'reset-password': 'reset_password',
    'magic-link': 'magic_link',
    'change-email': 'change_email',
  } as const;
  const link = (slug: keyof typeof PURPOSE, body: Record<string, unknown>) =>
    post('/v1/links', { ...body, purpose: PURPOSE[slug] });
  // **One route now** — §3.5, token in the body. The slug the test still uses
  // is its own vocabulary and no longer reaches the wire.
  const consume = (_slug: string, body: Record<string, unknown>) =>
    post('/v1/links/consume', body);

  it('15 — an unknown address gets the SAME 202 as a known one', async () => {
    // No status, no body, no timing signal a caller could read. The command
    // returns `void`, so there is nothing here that *could* differ.
    const h = harness();
    await signUp(h, 'ada@example.com');

    const known = await h.call(
      link('reset-password', { email: 'ada@example.com' }),
    );
    const unknown = await h.call(
      link('reset-password', { email: 'nobody@example.com' }),
    );

    expect(known.status).toBe(202);
    expect(unknown).toEqual({ ...known, headers: unknown.headers });
    expect(unknown.body).toBe(known.body);
    // And only one link was actually sent.
    expect(h.mail.sent()).toHaveLength(1);
  });

  it('13 — a link is single use', async () => {
    const h = harness();
    await signUp(h, 'ada@example.com');
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    const first = await h.call(
      consume('reset-password', {
        token: secret,
        password: 'a-brand-new-secret',
      }),
    );
    const second = await h.call(
      consume('reset-password', {
        token: secret,
        password: 'another-new-secret',
      }),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(400);
  });

  it('13 — every failure mode is ONE indistinguishable error', async () => {
    // Expired, already consumed, wrong purpose, never existed. Four distinct
    // errors is a probe: an attacker holding a stale link would learn whether
    // the address exists, whether somebody already used it, and whether they
    // guessed a real id.
    const h = harness();
    await signUp(h, 'ada@example.com');
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    // Already consumed.
    await h.call(
      consume('reset-password', { token: secret, password: 'a-new-secret-x' }),
    );
    const consumed = await h.call(
      consume('reset-password', { token: secret, password: 'a-new-secret-y' }),
    );

    // Never existed.
    const fabricated = await h.call(
      consume('reset-password', {
        token: 'not-a-real-secret',
        password: 'a-new-secret-z',
      }),
    );

    // Wrong purpose: a reset secret presented as a magic link.
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const fresh = h.mail.sent()[1]?.secret ?? '';
    const wrongPurpose = await h.call(consume('magic-link', { token: fresh }));

    for (const response of [consumed, fabricated, wrongPurpose]) {
      expect(response.status).toBe(400);
      expect(strip(response.body)).toEqual(strip(consumed.body));
    }
  });

  it('13 — an expired link is the same error', async () => {
    const h = harness({ challengeTtlMs: seconds(60) });
    await signUp(h, 'ada@example.com');
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    await h.clock.advance(seconds(120));

    const expired = await h.call(
      consume('reset-password', {
        token: secret,
        password: 'a-brand-new-secret',
      }),
    );
    expect(expired.status).toBe(400);
  });

  it('14 — a reset revokes ALL sessions, sparing none', async () => {
    // **The contrast with case 9.** A change spares the caller's session
    // because they proved they know the old password; a reset proves only
    // control of the mailbox, and the live session might be the attacker's.
    const h = harness();
    const first = await signUp(h, 'ada@example.com');
    const second = await logIn(h, 'ada@example.com');

    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    await h.call(
      consume('reset-password', {
        token: secret,
        password: 'a-brand-new-secret',
      }),
    );

    expect((await h.call(bearer(first.token))).status).toBe(401);
    expect((await h.call(bearer(second.token))).status).toBe(401);
  });

  it('14 — and the user`s OTHER outstanding reset links with them', async () => {
    // The half that gets forgotten. A second link mailed an hour earlier is
    // still live, and whoever triggered it still has it.
    const h = harness();
    await signUp(h, 'ada@example.com');

    await h.call(link('reset-password', { email: 'ada@example.com' }));
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const [older, newer] = h.mail.sent().map((one) => one.secret);

    await h.call(
      consume('reset-password', {
        token: newer ?? '',
        password: 'a-brand-new-secret',
      }),
    );

    const stale = await h.call(
      consume('reset-password', {
        token: older ?? '',
        password: 'attacker-chosen-x',
      }),
    );
    expect(stale.status).toBe(400);
  });

  it('does not expire another PURPOSE`s links', async () => {
    // The sweep is per purpose. A reset must not silently invalidate a
    // verification link the user is about to click.
    const h = harness();
    await signUp(h, 'ada@example.com');

    await h.call(link('verify-email', { email: 'ada@example.com' }));
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const [verify, reset] = h.mail.sent().map((one) => one.secret);

    await h.call(
      consume('reset-password', {
        token: reset ?? '',
        password: 'a-brand-new-secret',
      }),
    );

    expect(
      (await h.call(consume('verify-email', { token: verify ?? '' }))).status,
    ).toBe(204);
  });

  it('stores a fingerprint and a MAC, never the secret', async () => {
    const h = harness();
    await signUp(h, 'ada@example.com');
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    const rows = [...(h.identity.store?.challenges.values() ?? [])];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.secretFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rows[0]?.tag).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('keeps the secret off the event bus too', async () => {
    const h = harness();
    await signUp(h, 'ada@example.com');
    await h.call(link('reset-password', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    // An event is stored for the life of an audit record. A secret on one is a
    // credential in a table nobody thinks of as holding credentials.
    expect(JSON.stringify(h.events.published())).not.toContain(secret);
  });

  it('a magic link is the SECOND authentication method, and it converges', async () => {
    // **The convergence point paying for itself.** `magicLinkLogin` supplies a
    // user and a name; `authenticate` owns the TTL, the token, the
    // fingerprinting, the disabled check and both events.
    const h = harness();
    await signUp(h, 'ada@example.com');
    await h.call(link('magic-link', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    const response = await h.call(consume('magic-link', { token: secret }));
    expect(response.status).toBe(201);

    const token = (JSON.parse(response.body) as { access_token: string })
      .access_token;
    expect((await h.call(bearer(token))).status).toBe(200);

    // The session records **how** it was created — §2.2's `Session.Method`.
    const created = h.events
      .published()
      .filter((e) => e.name === 'identity.session.created');
    expect(created.map((e) => e.payload['method'])).toContain('magic_link');
  });

  it('refuses a magic link for a DISABLED user, via the same check', async () => {
    // Inherited rather than re-implemented: `authenticate` asserts it, so every
    // method that ever exists gets it without knowing it made a check.
    const h = harness();
    const { userId: id } = await signUp(h, 'ada@example.com');
    await h.call(link('magic-link', { email: 'ada@example.com' }));
    const secret = h.mail.sent()[0]?.secret ?? '';

    const user = await h.identity.deps.users.byId(userId(id));
    user?.disable(new Date());
    await h.identity.deps.transactor.within((work) =>
      work.users.save(present(user, 'the user')),
    );

    expect(
      (await h.call(consume('magic-link', { token: secret }))).status,
    ).toBe(400);
  });
});

describe('cases 16-17 — API keys', () => {
  const readPolicy = unwrap(
    compilePolicy({
      auditor: [
        { action: 'user:read', scope: Scope.Any },
        { action: 'user:write', scope: Scope.Any },
      ],
    }),
  );

  async function mintKey(
    h: Harness,
    owner: Registered,
    scopes: readonly string[] = ['user:read'],
  ): Promise<string> {
    const response = await h.call(
      post('/v1/me/keys', { name: 'ci', scopes }, owner.token),
    );
    expect(response.status).toBe(201);
    return (JSON.parse(response.body) as { secret: string }).secret;
  }

  it('16 — is shown once and never returned again', async () => {
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    const secret = await mintKey(h, owner);

    const listed = await h.call({
      method: 'GET',
      path: '/v1/me/keys',
      ...bearer(owner.token),
    });

    expect(listed.status).toBe(200);
    // **Not that we choose not to return it — there is nothing to return.**
    expect(listed.body).not.toContain(secret);
    expect(listed.body).not.toContain('secret');
  });

  it('16 — the store holds a fingerprint, not the key', async () => {
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    const secret = await mintKey(h, owner);

    const rows = [...(h.identity.store?.apiKeys.values() ?? [])];
    expect(rows[0]?.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(h.events.published())).not.toContain(secret);
  });

  it('carries a prefix, so a leaked key is scannable', async () => {
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');

    expect(await mintKey(h, owner)).toMatch(/^ak_/);
  });

  it('authenticates as its owner', async () => {
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    const secret = await mintKey(h, owner);

    const me = await h.call(bearer(secret));

    expect(me.status).toBe(200);
    expect((JSON.parse(me.body) as { id: string }).id).toBe(owner.userId);
  });

  it('16 — is REFUSED on key management, logout and password change', async () => {
    // The three the case names, and none of them declares `apiKeys: allowed`,
    // so the refusal is the default rather than three remembered checks.
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    const secret = await mintKey(h, owner);

    const minting = await h.call(
      post('/v1/me/keys', { name: 'another', scopes: [] }, secret),
    );
    const listing = await h.call({
      method: 'GET',
      path: '/v1/me/keys',
      ...bearer(secret),
    });
    const loggingOut = await h.call({
      method: 'DELETE',
      path: '/v1/sessions/current',
      ...bearer(secret),
    });
    const changing = await h.call(
      post(
        '/v1/me/password',
        {
          current_password: 'correct-horse-battery',
          new_password: 'a-brand-new-secret',
        },
        secret,
      ),
    );

    for (const response of [minting, listing, loggingOut, changing]) {
      // 403, not 401: the credential is valid and the caller identified — this
      // endpoint does not accept this *kind* of credential, and a 401 would
      // invite them to present it again.
      expect(response.status).toBe(403);
    }
  });

  it('a revoked key stops working immediately', async () => {
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    const secret = await mintKey(h, owner);
    const id = [...(h.identity.store?.apiKeys.values() ?? [])][0]?.id ?? '';

    const revoked = await h.call({
      method: 'DELETE',
      path: `/v1/me/keys/${id}`,
      ...bearer(owner.token),
    });

    expect(revoked.status).toBe(204);
    expect((await h.call(bearer(secret))).status).toBe(401);
  });

  it('a key cannot outlive its owner`s access', async () => {
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    const secret = await mintKey(h, owner);

    const user = await h.identity.deps.users.byId(userId(owner.userId));
    user?.disable(new Date());
    await h.identity.deps.transactor.within((work) =>
      work.users.save(present(user, 'the user')),
    );

    expect((await h.call(bearer(secret))).status).toBe(401);
  });

  it('17 — the Subject a key produces carries its SCOPES', async () => {
    // **The test that was missing, and the reason it was missing is
    // instructive.** The two cases below build a `Subject` by hand and then
    // assert `authz` intersects correctly — which tests `authz`, not this
    // context. Dropping the scopes from `subjectOf` changed nothing they saw.
    //
    // This asserts the half `identity` actually owns: the subject handed to an
    // authorization decision is built from the **owner's roles** with the
    // **key's scopes** attached.
    const h = harness();
    const owner = await signUp(h, 'ada@example.com');
    await seedRole(h, owner.userId, 'auditor');

    const user = await h.identity.deps.users.byId(userId(owner.userId));
    const key = ApiKey.issue(
      apiKeyId('01a024c7-9999-7000-8000-000000000001'),
      userId(owner.userId),
      'ci',
      'sha256:x',
      ['user:read'],
      new Date(),
    );

    const loaded = present(user, 'the user');
    const asSession = subjectOf({ user: loaded });
    const asKey = subjectOf({
      user: loaded,
      apiKey: key,
    });

    // Same person, same roles, both ways.
    expect(asKey.roles).toEqual(asSession.roles);
    expect(asSession.scopes).toBeUndefined();
    // And the key narrows.
    expect(asKey.scopes).toEqual(['user:read']);
  });

  it('17 — a scope SUBTRACTS from the owner`s grants', async () => {
    // The effective permission is the **intersection**. The owner holds
    // `auditor`, which grants both actions; the key is scoped to one, so it
    // reaches one.
    const h = harness({ authorizer: makeAuthorizer(readPolicy) });
    const owner = await signUp(h, 'ada@example.com');
    await seedRole(h, owner.userId, 'auditor');

    const narrow = await mintKey(h, owner, ['user:read']);

    const asOwner = h.identity.deps.authorizer.allow(
      subjectFor(h, owner, []),
      'user:write',
    );
    expect(asOwner.allowed).toBe(true);

    // The same person, through a key scoped to `user:read` only.
    const asKey = h.identity.deps.authorizer.allow(
      subjectFor(h, owner, ['user:read']),
      'user:write',
    );
    expect(asKey.allowed).toBe(false);
    void narrow;
  });

  it('17 — a scope can never GRANT what the owner lacks', async () => {
    // The inversion that would make case 17 useless: a key scoped to an action
    // its owner has no grant for must still be refused.
    const h = harness({ authorizer: makeAuthorizer(readPolicy) });
    const owner = await signUp(h, 'nobody@example.com');
    // No roles at all, so no grants.

    const decision = h.identity.deps.authorizer.allow(
      subjectFor(h, owner, ['user:write']),
      'user:write',
    );

    expect(decision.allowed).toBe(false);
  });
});

describe('every event carries what `audit` cannot look up — §2.5', () => {
  it('names the subject in the payload and the actor on the envelope', async () => {
    const h = harness();
    await signUp(h, 'ada@example.com');

    const registered = h.events
      .published()
      .find((e) => e.name === 'identity.user.registered');

    expect(registered?.payload['subject']).toMatch(/^[0-9a-f-]{36}$/);
    // The actor rides the envelope's provenance, never the payload.
    expect(registered?.provenance.actor.toString()).toBe('anonymous:');
    expect(registered?.provenance.correlationId).toBeDefined();
  });

  it('uses the specified names, past tense and dot-separated', async () => {
    const h = harness();
    await signUp(h, 'ada@example.com');

    const names = h.events.published().map((e) => e.name);
    expect(names).toContain('identity.user.registered');
    expect(names).toContain('identity.session.created');
    expect(names).toContain('identity.user.authenticated');
    for (const name of names) {
      expect(name).toMatch(/^identity\.[a-z_]+\.[a-z_]+$/);
    }
  });
});

/** Drop `instance`, which is the request id and differs by design. */
function strip(body: string): unknown {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const { instance, ...rest } = parsed;
  void instance;
  return rest;
}
