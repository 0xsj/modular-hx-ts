/**
 * **The journey**, written once and run against every storage mode.
 *
 * Register → log in twice → read `/me` → change the password → confirm the
 * *other* session is dead and *this* one live → log out → confirm the token is
 * refused → read the audit records that journey produced and confirm the
 * correlation id ties each one back to the request that caused it.
 *
 * `../../CONFORMANCE.md` cases 5, 6, 7, 9, 10, 11, 35, 37, 38, and — because it
 * is a journey rather than a checklist — the ordering between them, which is
 * where the defects were. Everything here passed as a set of unit tests while
 * `main.ts` mounted nothing at all: unit suites called handlers directly,
 * contract suites called adapters directly, and nothing asked whether the
 * process answered HTTP.
 *
 * **One body, two callers.** `journey.test.ts` runs it in memory with zero
 * external dependencies (invariant `I1`); `journey-postgres.test.ts` runs the
 * identical body against a real database. Two files that had each grown their
 * own copy would agree until the day they mattered.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type Started } from '../testx/process.js';
import { Journal } from '../testx/journal.js';

/**
 * What the routes answer, as this journey reads them.
 *
 * Declared here rather than imported from `src/`: an end-to-end test that
 * imported the server's own view types would agree with the server by
 * construction, and stop being able to notice the day the wire shape changed.
 * These are what a *client* believes, written down.
 */
interface UserReply {
  readonly id: string;
  readonly email: string;
  readonly display_name?: string;
  readonly roles: readonly string[];
  readonly status: 'active' | 'disabled';
}

interface TokenReply {
  // **Snake case, and it is the contract** — `CONFORMANCE.md` §3.5. The cases
  // interpolate `$access_token` sixty times, and a client must not be able to
  // tell which blueprint it reached.
  readonly access_token: string;
  readonly user_id: string;
  readonly session_id: string;
}

interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
}

interface OrgReply {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'archived';
  readonly your_role?: string;
}

interface RecordReply {
  readonly event: string;
  readonly actor: string;
  readonly subject?: string;
  readonly requestId: string;
  readonly correlationId: string;
}

interface ChangedReply {
  readonly revokedSessions: number;
}

export interface JourneyOptions {
  /** Credentials `make seed` was run with, when the caller seeded first. */
  readonly bootstrap?: { readonly email: string; readonly password: string };
  /** Appears in the artifact's title, so two runs are told apart. */
  readonly mode: string;
  /** Handed to the process verbatim. */
  readonly env: Record<string, string>;
  readonly artifact: string;
}

/**
 * Retry a read until it satisfies a predicate, or give up loudly.
 *
 * **Only the audit reads need this, and the reason is the point.** In memory
 * mode a subscriber runs in-process during the publishing transaction, so a
 * record is there the moment the request returns. In Postgres mode the event
 * goes to the outbox and a relay delivers it a moment later — delivery is
 * *eventual*, by design, because that is what buys atomicity between the write
 * and the event.
 *
 * A journey that asserted immediately would pass in one mode and fail in the
 * other, and the tempting fix — a fixed `sleep` — is the one that turns into a
 * flake on a slow machine. This waits for the condition and reports how long it
 * took to arrive.
 */
async function eventually<T>(
  what: string,
  read: () => Promise<T>,
  satisfied: (value: T) => boolean,
  within = 15_000,
): Promise<T> {
  const deadline = Date.now() + within;
  let last = await read();
  while (!satisfied(last) && Date.now() < deadline) {
    await new Promise((resume) => setTimeout(resume, 250));
    last = await read();
  }
  if (!satisfied(last)) {
    throw new Error(`${what} did not arrive within ${String(within)}ms`);
  }
  return last;
}

export function theJourney(options: JourneyOptions): void {
  /** What this journey must leave behind. Waited for, then asserted. */
  const EXPECTED = [
    'identity.user.registered',
    'identity.user.authenticated',
    'identity.session.created',
    'identity.user.password_changed',
    'identity.session.revoked',
  ] as const;

  /** What the organization chapter must leave behind. Waited for, then asserted. */
  const ORG_EVENTS = [
    'orgs.organization.founded',
    'orgs.membership.joined',
    'orgs.invitation.sent',
  ] as const;

  const PASSWORD = 'correct horse battery staple';
  const NEXT_PASSWORD = 'a different horse entirely!';

  let app: Started;
  let http: Journal;
  const email = `ada+${String(Date.now())}@example.com`;

  /** Filled as the journey runs; asserted at the end, together. */
  const seen = {
    userId: '',
    otherToken: '',
    currentToken: '',
    registerRequestId: '',
    changeRequestId: '',
  };

  beforeAll(async () => {
    app = await serve(options.env);
    http = new Journal({
      base: app.base,
      artifact: options.artifact,
      title: `The identity journey, ${options.mode}`,
    });
    // Registered before the first exchange, so neither ever reaches the artifact
    // in plaintext. A journal is a document somebody looks at; a document with a
    // password in it is a document nobody can share.
    http.secret(PASSWORD);
    http.secret(NEXT_PASSWORD);
  }, 60_000);

  afterAll(async () => {
    // The artifact is written whatever the verdict — a journal of a *failed*
    // journey is the one somebody actually needs to read.
    http.finish();
    await app.stop();
  });

  describe('the process that answers', () => {
    it('announced what it did not wire, at boot', () => {
      // **The point of the announcement.** A root that skips something says so;
      // an empty list would be the claim that nothing was left out. Asserting the
      // list is non-empty here is asserting that the claim is being made at all.
      expect(app.skipped.length).toBeGreaterThan(0);
      expect(app.skipped.map((one) => one.what)).toContain(
        'deadline (chain position 5)',
      );
      for (const one of app.skipped) expect(one.why).not.toBe('');
    });

    it('serves liveness and readiness without a credential', async () => {
      http.step('The probes');

      const live = await http.send('GET', '/healthz');
      const ready = await http.send('GET', '/readyz');

      expect(live.status).toBe(200);
      expect(ready.status).toBe(200);
      // Never rate-limited: an orchestrator polling readiness must not be able to
      // throttle itself into a restart loop.
      expect(live.headers['ratelimit-limit']).toBeUndefined();
    });

    it('names the binary at /version, anonymously — §3.9', async () => {
      // **This 404'd for six phases.** `shared/buildinfo` exported
      // `versionPayload` and its own header said *served at `/version`*, and
      // nothing mounted it — a module documenting a caller it did not have.
      //
      // §3.9 turned it from a convenience into evidence: the ports in this
      // collection are adjacent, one blueprint reported numbers taken from a
      // sibling's process, and this endpoint is how a report proves which
      // binary answered. So it is checked from the outside, against the real
      // listener, rather than by asserting the function exists.
      http.step('Which binary is this');

      const version = await http.send<{ name: string; commit: string }>(
        'GET',
        '/version',
      );

      expect(version.status).toBe(200);
      expect(version.body.name).toBe('modular-hx-ts');
      expect(version.body.commit).not.toBe('');
    });
  });

  describe('the journey', () => {
    it('registers — case 5', async () => {
      http.step('Register');

      const created = await http.send<UserReply>('POST', '/v1/users', {
        body: { email, password: PASSWORD },
      });

      expect(created.status).toBe(201);
      expect(created.body.email).toBe(email.toLowerCase());
      // **The role a signup confers.** Empty here meant every registered user got
      // 403 from `/v1/audit` — the one thing the policy grants everybody.
      expect(created.body.roles).toEqual(['member']);
      seen.userId = created.body.id;
      seen.registerRequestId = created.headers['x-request-id'] ?? '';
      expect(seen.registerRequestId).not.toBe('');
    });

    it('refuses the wrong password with the same answer as an unknown address — case 7', async () => {
      http.step('Two ways to fail a login');

      const wrongPassword = await http.send<Problem>('POST', '/v1/sessions', {
        body: { email, password: 'not the password at all' },
      });
      const unknownAddress = await http.send<Problem>('POST', '/v1/sessions', {
        body: {
          email: `nobody+${String(Date.now())}@example.com`,
          password: PASSWORD,
        },
      });

      expect(wrongPassword.status).toBe(401);
      expect(unknownAddress.status).toBe(401);
      // Identical but for the instance, which is this request's id and must
      // differ — an identical instance would mean the id is not per-request.
      const { instance: first, ...a } = wrongPassword.body;
      const { instance: second, ...b } = unknownAddress.body;
      expect(a).toEqual(b);
      expect(first).not.toBe(second);
    });

    it('logs in twice — case 6', async () => {
      http.step('Log in, twice');

      const other = await http.send<TokenReply>('POST', '/v1/sessions', {
        body: { email, password: PASSWORD },
      });
      const current = await http.send<TokenReply>('POST', '/v1/sessions', {
        body: { email, password: PASSWORD },
      });

      expect(other.status).toBe(201);
      expect(current.status).toBe(201);
      seen.otherToken = http.secret(other.body.access_token);
      seen.currentToken = http.secret(current.body.access_token);
      expect(seen.otherToken).not.toBe(seen.currentToken);
      expect(other.body.user_id).toBe(seen.userId);
    });

    it('reads /me, and the representation carries a strong ETag', async () => {
      http.step('Read /me');

      const me = await http.send<UserReply>('GET', '/v1/me', {
        headers: { authorization: `Bearer ${seen.currentToken}` },
      });

      expect(me.status).toBe(200);
      expect(me.body.id).toBe(seen.userId);
      // **A representation, not a version** — decision 0003's reading. Strong,
      // and derived from what was rendered.
      const etag = me.headers['etag'] ?? '';
      expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);

      const again = await http.send('GET', '/v1/me', {
        headers: {
          authorization: `Bearer ${seen.currentToken}`,
          'if-none-match': etag,
        },
      });
      expect(again.status).toBe(304);
    });

    it('refuses /me without a credential', async () => {
      http.step('No credential');

      const refused = await http.send('GET', '/v1/me');

      expect(refused.status).toBe(401);
      expect(refused.headers['content-type']).toContain(
        'application/problem+json',
      );
      // Even a refusal carries the id, or nobody can correlate the refusal.
      expect(refused.headers['x-request-id']).toBeDefined();
    });

    it('changes the password, killing every OTHER session — case 9', async () => {
      http.step('Change the password');

      const changed = await http.send<ChangedReply>('POST', '/v1/me/password', {
        headers: { authorization: `Bearer ${seen.currentToken}` },
        body: { current_password: PASSWORD, new_password: NEXT_PASSWORD },
      });

      expect(changed.status).toBe(200);
      expect(changed.body.revokedSessions).toBeGreaterThan(0);
      seen.changeRequestId = changed.headers['x-request-id'] ?? '';
    });

    it('leaves the other session dead and this one live — the case-9 half that is easy to invert', async () => {
      http.step('Which session survived');

      const other = await http.send('GET', '/v1/me', {
        headers: { authorization: `Bearer ${seen.otherToken}` },
      });
      const current = await http.send('GET', '/v1/me', {
        headers: { authorization: `Bearer ${seen.currentToken}` },
      });

      expect(other.status).toBe(401);
      expect(current.status).toBe(200);
    });

    it('accepts the new password and refuses the old one', async () => {
      http.step('The new password works');

      const withNew = await http.send<TokenReply>('POST', '/v1/sessions', {
        body: { email, password: NEXT_PASSWORD },
      });
      const withOld = await http.send<Problem>('POST', '/v1/sessions', {
        body: { email, password: PASSWORD },
      });

      expect(withNew.status).toBe(201);
      expect(withOld.status).toBe(401);
      http.secret(withNew.body.access_token);
    });

    it('logs out, and the token stops working — case 11', async () => {
      http.step('Log out');

      const out = await http.send('DELETE', '/v1/sessions/current', {
        headers: { authorization: `Bearer ${seen.currentToken}` },
      });
      const after = await http.send('GET', '/v1/me', {
        headers: { authorization: `Bearer ${seen.currentToken}` },
      });

      expect(out.status).toBe(204);
      expect(after.status).toBe(401);
    });
  });

  describe('an organization, and a role inside it', () => {
    let orgId = '';
    let token = '';

    beforeAll(async () => {
      const back = await http.send<TokenReply>('POST', '/v1/sessions', {
        body: { email, password: NEXT_PASSWORD },
      });
      token = http.secret(back.body.access_token);
    });

    it('founds one, and the founder is its first owner', async () => {
      http.step('Found an organization');

      const founded = await http.send<OrgReply>('POST', '/v1/orgs', {
        headers: { authorization: `Bearer ${token}` },
        body: { name: `Journey ${String(Date.now())}` },
      });

      expect(founded.status).toBe(201);
      expect(founded.body.your_role).toBe('owner');
      orgId = founded.body.id;
    });

    it('shows the caller their OWN role in it', async () => {
      http.step('Read the organization');

      const read = await http.send<OrgReply>('GET', `/v1/orgs/${orgId}`, {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(read.status).toBe(200);
      expect(read.body.your_role).toBe('owner');
      // **The second `Validators` implementer, running.** Until `orgs` existed
      // the root passed identity's straight through, and this route declared a
      // tag nothing produced.
      expect(read.headers['etag']).toMatch(/^"sha256:[0-9a-f]{64}"$/);
    });

    it('refuses to let the last owner leave — the set-spanning invariant', async () => {
      http.step('The last owner cannot leave');

      const refused = await http.send<Problem>(
        'DELETE',
        `/v1/orgs/${orgId}/members/me`,
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(refused.status).toBe(409);
      expect(refused.body.type).toBe('/problems/last-owner');
    });

    it('invites somebody, and the invitation is single use', async () => {
      http.step('Invite');

      const invited = await http.send('POST', `/v1/orgs/${orgId}/invitations`, {
        headers: { authorization: `Bearer ${token}` },
        body: {
          email: `invitee+${String(Date.now())}@example.test`,
          role: 'member',
        },
      });
      const pending = await http.send<{ id: string }[]>(
        'GET',
        `/v1/orgs/${orgId}/invitations`,
        { headers: { authorization: `Bearer ${token}` } },
      );

      expect(invited.status).toBe(202);
      expect(pending.status).toBe(200);
      expect(pending.body.length).toBeGreaterThan(0);
      // **No secret anywhere in the view.** Nothing here reads one.
      expect(JSON.stringify(pending.body)).not.toContain('fingerprint');
    });

    it('lists the caller`s organizations, and nobody else`s', async () => {
      http.step('My organizations');

      const mine = await http.send<OrgReply[]>('GET', '/v1/orgs', {
        headers: { authorization: `Bearer ${token}` },
      });

      expect(mine.status).toBe(200);
      expect(mine.body.map((one) => one.id)).toContain(orgId);
    });

    it('is 404, not 403, for a stranger — no existence oracle', async () => {
      http.step('Somebody else`s organization');

      const stranger = await http.send<TokenReply>('POST', '/v1/users', {
        body: {
          email: `stranger+${String(Date.now())}@example.test`,
          password: 'a stranger password here',
        },
      });
      expect(stranger.status).toBe(201);

      const session = await http.send<TokenReply>('POST', '/v1/sessions', {
        body: {
          email: (stranger.body as unknown as { email: string }).email,
          password: 'a stranger password here',
        },
      });
      const theirs = http.secret(session.body.access_token);

      const refused = await http.send('GET', `/v1/orgs/${orgId}`, {
        headers: { authorization: `Bearer ${theirs}` },
      });

      expect(refused.status).toBe(404);
    });

    it('records what happened in the audit log', async () => {
      http.step('The organization in the audit trail');

      const records = await eventually(
        'the organization records',
        () =>
          http.send<RecordReply[]>('GET', '/v1/audit', {
            headers: { authorization: `Bearer ${token}` },
          }),
        // **Every event the assertions need, not just the first.** Waiting on
        // one and asserting three is the same race that flaked the identity
        // chapter: the relay claims a batch and nothing promises the order two
        // records reach the table in. It flaked once here before this, which is
        // the number of times a race like this announces itself.
        (answer) =>
          answer.status === 200 &&
          ORG_EVENTS.every((event) =>
            answer.body.some((one) => one.event === event),
          ),
      );

      const events = records.body.map((one) => one.event);
      for (const event of ORG_EVENTS) expect(events).toContain(event);
    });
  });

  describe('what the journey left in the audit log', () => {
    let token = '';

    beforeAll(async () => {
      const back = await http.send<TokenReply>('POST', '/v1/sessions', {
        body: { email, password: NEXT_PASSWORD },
      });
      token = http.secret(back.body.access_token);
    });

    it('recorded the journey — cases 35 and 37', async () => {
      http.step('Read the audit log');

      const records = await eventually(
        "the journey's audit records",
        () =>
          http.send<RecordReply[]>('GET', '/v1/audit', {
            headers: { authorization: `Bearer ${token}` },
          }),
        // **Every event the assertions below need, not just the last one.**
        // Waiting on one and asserting on five is a race: the outbox relay
        // claims a batch and dispatches it, and nothing promises the order two
        // records reach the table in. It flaked exactly once before this,
        // which is the number of times a race like this announces itself.
        (answer) =>
          answer.status === 200 &&
          EXPECTED.every((event) =>
            answer.body.some((one) => one.event === event),
          ),
      );

      expect(records.status).toBe(200);
      const events = records.body.map((one) => one.event);
      for (const event of EXPECTED) expect(events).toContain(event);

      // **Case 37: policy-scoped**, and the scope is *actor or subject* — not
      // *subject*. This asserted `subject === me` and passed for six phases,
      // because every `identity` event names the acting user as its payload
      // subject too. An `orgs` event whose subject is an **organization**
      // broke it, and the assertion was the thing that was wrong: it had been
      // accidentally asserting that the actor half of the scope did nothing.
      for (const one of records.body) {
        expect(
          one.actor === `user:${seen.userId}` || one.subject === seen.userId,
          `${one.event} is neither acted by nor about this caller`,
        ).toBe(true);
      }
    });

    it('ties each record back to the request that caused it — case 38', async () => {
      http.step('Correlation across the boundary');

      const registered = await eventually(
        'the registration record',
        () =>
          http.send<RecordReply[]>(
            'GET',
            `/v1/audit?event=identity.user.registered`,
            { headers: { authorization: `Bearer ${token}` } },
          ),
        (answer) =>
          answer.status === 200 &&
          answer.body.some((one) => one.subject === seen.userId),
      );

      expect(registered.status).toBe(200);
      const mine = registered.body.filter((one) => one.subject === seen.userId);
      expect(mine).toHaveLength(1);
      const only = mine[0];
      if (only === undefined) throw new Error('unreachable');
      // **The whole point.** `audit` subscribed to an event `identity` published
      // inside a transaction, in another context, and the correlation id is the
      // one the register request carried — not a new one minted by the
      // subscriber, which is what a naive `Carrier.run` in the bus would produce.
      expect(only.correlationId).toBe(seen.registerRequestId);
      expect(only.requestId).toBe(seen.registerRequestId);
    });

    it('finds the password change by the request id it was given', async () => {
      http.step('Search by correlation id');

      const found = await eventually(
        'the records that request caused',
        () =>
          http.send<RecordReply[]>(
            'GET',
            `/v1/audit?correlation=${seen.changeRequestId}`,
            { headers: { authorization: `Bearer ${token}` } },
          ),
        (answer) => answer.status === 200 && answer.body.length > 1,
      );

      expect(found.status).toBe(200);
      const events = found.body.map((one) => one.event);
      // One request, more than one event, one correlation id: the change and the
      // revocations it caused.
      expect(events).toContain('identity.user.password_changed');
      expect(found.body.length).toBeGreaterThan(1);
    });
  });
}
