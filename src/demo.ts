/**
 * Demo data. **Rung 0a** — `../INFRASTRUCTURE.md`.
 *
 * > A person who clones this can reach something in five minutes.
 *
 * The bootstrap administrator (`CONTEXTS.md` §7.4) is the base case that makes
 * roles reachable at all. This is the other thing: **enough of a world that a
 * stranger logging in sees a system that has been used**, rather than an empty
 * table and no idea whether anything works.
 *
 * **Driven through the HTTP surface, not through the repositories.** The same
 * constraint the conformance corpus loader carries, and for the same reason: a
 * demo world that cannot be created through the API is describing a state the
 * product cannot reach, and writing rows directly would hide exactly that. It
 * also means every audit record here has a real request behind it, with a real
 * correlation id — which is the thing worth looking at.
 *
 * It is **idempotent**: a second run finds the accounts already registered and
 * adds nothing. `make dev` restarting is not a reason to double the data.
 */

import { type Handler, type Request } from './shared/edge/index.js';
import { type Origins, Carrier } from './shared/provenance/index.js';

export interface DemoOptions {
  readonly handler: Handler;
  readonly origins: Origins;
  /** The bootstrap administrator, so the grants below have somebody to make them. */
  readonly administrator: { readonly email: string; readonly password: string };
  readonly log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** Everybody's password. A demo, and it is said out loud rather than guessed. */
export const DEMO_PASSWORD = 'demo-password-123';

interface Person {
  readonly email: string;
  readonly displayName: string;
  /** Given after registration, by the administrator. */
  readonly role?: string;
}

/**
 * The cast.
 *
 * Names rather than `user1@example.com`, because the first thing a stranger
 * does is read the list, and a list of placeholders tells them the template
 * was never used by anybody either.
 */
/** Suspended and reinstated, so the trail has an actor who is not the subject. */
const SUSPENDED = 'edsger@example.test';

const PEOPLE: readonly Person[] = [
  { email: 'ada@example.test', displayName: 'Ada Lovelace', role: 'auditor' },
  { email: 'alan@example.test', displayName: 'Alan Turing' },
  { email: 'grace@example.test', displayName: 'Grace Hopper' },
  { email: 'katherine@example.test', displayName: 'Katherine Johnson' },
  { email: 'edsger@example.test', displayName: 'Edsger Dijkstra' },
  { email: 'barbara@example.test', displayName: 'Barbara Liskov' },
];

export interface DemoReport {
  readonly registered: number;
  readonly alreadyThere: number;
  readonly rolesGranted: number;
  readonly auditRecords: number;
}

export async function seedDemo(options: DemoOptions): Promise<DemoReport> {
  const { handler, origins, log } = options;

  /** One request, inside its own origin — so every record has a real one. */
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    token?: string,
    extra: Record<string, string> = {},
  ): Promise<{
    status: number;
    body: unknown;
    headers: Record<string, string>;
  }> => {
    const request: Request = {
      method,
      path,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...extra,
      },
      query: {},
      peer: '127.0.0.1',
      body: () =>
        Promise.resolve(body === undefined ? '' : JSON.stringify(body)),
    };

    return Carrier.run(origins.forCli('seed'), async () => {
      const response = await handler({
        request,
        provenance: Carrier.current(),
        responseHeaders: {},
        remaining: () => 30_000,
      } as never);

      let parsed: unknown = response.body;
      try {
        parsed = JSON.parse(response.body) as unknown;
      } catch {
        /* a 204 has no body, and that is not an error */
      }
      return {
        status: response.status,
        body: parsed,
        headers: response.headers,
      };
    });
  };

  const login = async (email: string, password: string): Promise<string> => {
    const answer = await call('POST', '/v1/sessions', { email, password });
    const body = answer.body as { access_token?: string };
    if (answer.status !== 201 || body.access_token === undefined) {
      throw new Error(`the demo could not log in as ${email}`);
    }
    return body.access_token;
  };

  const adminToken = await login(
    options.administrator.email,
    options.administrator.password,
  );

  let registered = 0;
  let alreadyThere = 0;
  let rolesGranted = 0;

  for (const person of PEOPLE) {
    const created = await call('POST', '/v1/users', {
      email: person.email,
      password: DEMO_PASSWORD,
      display_name: person.displayName,
    });

    // **409 is the idempotent case, not a failure.** A restarted `make dev`
    // must not double the world.
    if (created.status === 409) {
      alreadyThere += 1;
      continue;
    }
    if (created.status !== 201) {
      log.warn('the demo could not register somebody', {
        email: person.email,
        status: created.status,
      });
      continue;
    }
    registered += 1;

    const id = (created.body as { id: string }).id;

    if (person.role !== undefined) {
      const granted = await call(
        'POST',
        `/v1/users/${id}/roles`,
        { role: person.role },
        adminToken,
      );
      if (granted.status === 200) rolesGranted += 1;
    }

    // **A history, not a snapshot.** Everybody logs in and out, which is what
    // turns an empty audit log into one with something to follow — and each of
    // these is a real request with its own correlation id, which is the thing
    // worth looking at.
    const token = await login(person.email, DEMO_PASSWORD);
    await call('DELETE', '/v1/sessions/current', undefined, token);

    // One person is suspended and reinstated by the administrator, so the trail
    // has an entry where the **actor is not the subject** — the case that
    // matters, and the one an empty demo never shows. Deliberately not a
    // password change: everybody's password stays `DEMO_PASSWORD`, and a demo
    // where one account is secretly different is a demo that wastes somebody's
    // afternoon.
    if (person.email === SUSPENDED) {
      // **Read, then write against what you read.** `PATCH` requires an
      // `If-Match`, and the demo obeys it rather than working around it — a
      // demo that skipped the precondition would be showing a flow the product
      // does not have.
      const suspend = async (status: 'active' | 'disabled'): Promise<void> => {
        const read = await call(
          'GET',
          `/v1/users/${id}`,
          undefined,
          adminToken,
        );
        const tag = read.headers['etag'];
        if (tag === undefined) return;
        await call('PATCH', `/v1/users/${id}`, { status }, adminToken, {
          'if-match': tag,
        });
      };
      await suspend('disabled');
      await suspend('active');
    }
  }

  // **An organization, so the demo shows the thing `orgs` exists for.** A
  // stranger logging in sees a role *inside* something rather than a flat
  // account role, which is the distinction the whole context is about.
  let orgsFounded = 0;
  const founded = await call(
    'POST',
    '/v1/orgs',
    { name: 'Bletchley Park' },
    adminToken,
  );
  if (founded.status === 201) {
    orgsFounded = 1;
    const id = (founded.body as { id: string }).id;
    // Two invitations, one accepted — so the demo has both a member and an
    // outstanding invitation to look at.
    for (const person of PEOPLE.slice(0, 2)) {
      await call(
        'POST',
        `/v1/orgs/${id}/invitations`,
        { email: person.email, role: 'member' },
        adminToken,
      );
    }
  } else if (founded.status === 409) {
    // The second run. Nothing to do, and not a failure.
    orgsFounded = 0;
  } else {
    log.warn('the demo could not found an organization', {
      status: founded.status,
    });
  }

  const trail = await call('GET', '/v1/audit', undefined, adminToken);
  const auditRecords = Array.isArray(trail.body) ? trail.body.length : 0;

  log.info('demo data', {
    organizations: orgsFounded,
    registered,
    already_there: alreadyThere,
    roles_granted: rolesGranted,
    audit_records: auditRecords,
    log_in_with: DEMO_PASSWORD,
  });

  return { registered, alreadyThere, rolesGranted, auditRecords };
}
