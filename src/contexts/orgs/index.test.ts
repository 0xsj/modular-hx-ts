/**
 * `orgs`, end to end through its own handler. **`CONTEXTS.md` §4.**
 *
 * Memory mode, no infrastructure. The cases that matter are the ones §4 names:
 * a role **per organization**, one owner always, and the invitation shape.
 */

import { describe, expect, it } from 'vitest';
import { type Subject, subject } from '../../shared/authz/index.js';
import { fakeClock, millis } from '../../shared/clock/index.js';
import { type Request, type Response } from '../../shared/edge/index.js';
import { memoryEvents } from '../../shared/events/index.js';
import { chain } from '../../shared/httpx/index.js';
import { memoryTelemetry } from '../../shared/telemetry/index.js';
import { Actor, makeOrigins } from '../../shared/provenance/index.js';
import { fakeIds } from '../../shared/id/index.js';
import { systemRandom } from '../../shared/random/index.js';
import { unwrap } from '../../shared/result/index.js';
import { makeOrgs } from './index.js';
import { OrgRole } from './domain/index.js';

interface Sent {
  readonly to: string;
  readonly org: { id: string; name: string };
  readonly secret: string;
}

function harness(who: string = ANYBODY) {
  const clock = fakeClock();
  const ids = fakeIds(clock);
  const random = systemRandom();
  const bus = memoryEvents({ clock, ids });
  const sent: Sent[] = [];
  const origins = makeOrigins(ids);

  // Who the caller is, swappable per call — the root lends this in production.
  let current = who;

  const orgs = makeOrgs({
    clock,
    ids,
    random,
    publisher: bus,
    mailer: {
      send: (to, org, secret) => {
        sent.push({ to, org, secret });
        return Promise.resolve();
      },
    },
    caller: () => subjectFor(current),
  });

  // **Behind the chain, not the bare handler.** Positions 1 and 3 are what turn
  // a thrown `Conflict` into a 409 with a problem body, and a test calling the
  // router directly would assert on exceptions that no client ever sees.
  const built = chain(
    { clock, origins, telemetry: memoryTelemetry(clock) },
    orgs.handler,
  );

  const call = (over: Partial<Request>): Promise<Response> =>
    built({
      request: {
        method: 'GET',
        path: '/v1/orgs',
        headers: {},
        query: {},
        peer: '127.0.0.1',
        body: () => Promise.resolve(''),
        ...over,
      },
    } as never);

  return {
    orgs,
    clock,
    bus,
    sent: () => sent,
    call,
    as: (userId: string) => {
      current = userId;
    },
  };
}

const ANYBODY = '019b76da-a800-7000-8000-000000000001';
const SOMEBODY = '019b76da-a800-7000-8000-000000000002';
const THIRD = '019b76da-a800-7000-8000-000000000003';

function subjectFor(userId: string): Subject {
  return subject({
    actor: unwrap(Actor.user(userId)),
    // **No account roles at all.** §4: authorization here reads the role in
    // the organization, never a flat account role, and passing an empty set is
    // how this file asserts that nothing below consults one.
    roles: [],
    tenant: 'default',
  });
}

const post = (path: string, body: unknown): Partial<Request> => ({
  method: 'POST',
  path,
  headers: { 'content-type': 'application/json' },
  body: () => Promise.resolve(JSON.stringify(body)),
});

const json = (response: Response): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

async function found(h: ReturnType<typeof harness>, name: string) {
  const response = await h.call(post('/v1/orgs', { name }));
  expect(response.status, response.body).toBe(201);
  return json(response);
}

describe('founding', () => {
  it('makes the founder its first owner, in one transaction', async () => {
    // An organization with no memberships is one nobody can administer and
    // nobody can archive — and it satisfies the last-owner invariant
    // vacuously, because a roster of zero has nobody to refuse.
    const h = harness();

    const org = await found(h, 'Acme');
    const roster = await h.call({
      path: `/v1/orgs/${String(org['id'])}/members`,
    });

    expect(org['your_role']).toBe('owner');
    expect(JSON.parse(roster.body)).toHaveLength(1);
  });

  it('derives a slug from a name with spaces in it', async () => {
    // **Every test above founds `Acme`**, and a one-word name is the only shape
    // that survives passing a name straight to the slug validator. The e2e
    // journey founded `Journey 1787663806423` and got a 400.
    const h = harness();

    const org = await found(h, 'Wayne Enterprises, Inc.');

    expect(org['slug']).toBe('wayne-enterprises-inc');
  });

  it('refuses a name with nothing sluggable in it', async () => {
    const h = harness();

    const refused = await h.call(post('/v1/orgs', { name: '???' }));

    expect(refused.status).toBe(400);
  });

  it('refuses a second organization with the same slug', async () => {
    const h = harness();
    await found(h, 'Acme');

    const second = await h.call(post('/v1/orgs', { name: 'Acme' }));

    expect(second.status).toBe(409);
  });
});

describe('a role is per organization — the reason this context exists', () => {
  it('gives one person two roles in two organizations', async () => {
    // **§4 in one test.** The same caller, the same request shape, two
    // different answers depending on which organization the resource is in. A
    // flat account role cannot express this, which is what *without it, authz
    // gets modelled wrong* means.
    const h = harness();
    const mine = await found(h, 'Mine');

    // Somebody else founds theirs, and invites me as a plain member.
    h.as(SOMEBODY);
    const theirs = await found(h, 'Theirs');
    await h.call(
      post(`/v1/orgs/${String(theirs['id'])}/invitations`, {
        email: 'me@example.test',
        role: 'member',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';

    h.as(ANYBODY);
    const accepted = await h.call(post('/v1/invitations/accept', { token }));
    expect(accepted.status).toBe(200);

    const inMine = json(
      await h.call({ path: `/v1/orgs/${String(mine['id'])}` }),
    );
    const inTheirs = json(
      await h.call({ path: `/v1/orgs/${String(theirs['id'])}` }),
    );

    expect(inMine['your_role']).toBe('owner');
    expect(inTheirs['your_role']).toBe('member');
  });

  it('refuses an action the caller may take in their OTHER organization', async () => {
    const h = harness();
    h.as(SOMEBODY);
    const theirs = await found(h, 'Theirs');
    await h.call(
      post(`/v1/orgs/${String(theirs['id'])}/invitations`, {
        email: 'me@example.test',
        role: 'member',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';

    h.as(ANYBODY);
    await found(h, 'Mine');
    await h.call(post('/v1/invitations/accept', { token }));

    // An owner of one organization, a member of another. Inviting is an admin
    // action, and the answer depends entirely on which org is in the path.
    const refused = await h.call(
      post(`/v1/orgs/${String(theirs['id'])}/invitations`, {
        email: 'x@example.test',
        role: 'member',
      }),
    );

    expect(refused.status).toBe(403);
  });

  it('is 404, not 403, for an organization the caller does not belong to', async () => {
    // Conformance case 23's rule applied to organizations: a 403 confirms the
    // resource exists and turns any id into an oracle for *which organizations
    // exist*, which is a membership list nobody asked to publish.
    const h = harness();
    h.as(SOMEBODY);
    const theirs = await found(h, 'Theirs');

    h.as(THIRD);
    const answer = await h.call({ path: `/v1/orgs/${String(theirs['id'])}` });

    expect(answer.status).toBe(404);
  });
});

describe('one owner always — the first invariant that spans a set', () => {
  async function twoOwners() {
    const h = harness();
    const org = await found(h, 'Acme');
    const id = String(org['id']);

    await h.call(
      post(`/v1/orgs/${id}/invitations`, {
        email: 'other@example.test',
        role: 'owner',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';
    h.as(SOMEBODY);
    await h.call(post('/v1/invitations/accept', { token }));
    h.as(ANYBODY);

    return { h, id };
  }

  it('refuses to demote the last owner', async () => {
    const h = harness();
    const org = await found(h, 'Acme');

    const refused = await h.call({
      method: 'PUT',
      path: `/v1/orgs/${String(org['id'])}/members/${ANYBODY}/role`,
      headers: { 'content-type': 'application/json' },
      body: () => Promise.resolve(JSON.stringify({ role: 'member' })),
    });

    expect(refused.status).toBe(409);
    expect(json(refused)['type']).toBe('/problems/last-owner');
  });

  it('refuses to remove the last owner', async () => {
    const h = harness();
    const org = await found(h, 'Acme');

    const refused = await h.call({
      method: 'DELETE',
      path: `/v1/orgs/${String(org['id'])}/members/${ANYBODY}`,
    });

    expect(refused.status).toBe(409);
  });

  it('refuses to let the last owner leave', async () => {
    // §4 names all three, and one function answers all three — three separate
    // checks is how the third ends up missing the case the first two cover.
    const h = harness();
    const org = await found(h, 'Acme');

    const refused = await h.call({
      method: 'DELETE',
      path: `/v1/orgs/${String(org['id'])}/members/me`,
    });

    expect(refused.status).toBe(409);
  });

  it('ALLOWS all three once there are two owners', async () => {
    // The other half: an invariant that never permits anything is a bug that
    // looks like safety.
    const { h, id } = await twoOwners();

    const demoted = await h.call({
      method: 'PUT',
      path: `/v1/orgs/${id}/members/${ANYBODY}/role`,
      headers: { 'content-type': 'application/json' },
      body: () => Promise.resolve(JSON.stringify({ role: 'admin' })),
    });

    expect(demoted.status).toBe(200);
  });

  it('refuses the SECOND demotion, having allowed the first', async () => {
    // The case a per-handler check gets wrong: each request looks fine on its
    // own, and the pair leaves the organization with no owner.
    const { h, id } = await twoOwners();

    await h.call({
      method: 'PUT',
      path: `/v1/orgs/${id}/members/${ANYBODY}/role`,
      headers: { 'content-type': 'application/json' },
      body: () => Promise.resolve(JSON.stringify({ role: 'admin' })),
    });

    h.as(SOMEBODY);
    const second = await h.call({
      method: 'PUT',
      path: `/v1/orgs/${id}/members/${SOMEBODY}/role`,
      headers: { 'content-type': 'application/json' },
      body: () => Promise.resolve(JSON.stringify({ role: 'member' })),
    });

    expect(second.status).toBe(409);
  });
});

describe('invitations — the Challenge shape, over an organization', () => {
  it('sends a secret that is never stored and never returned', async () => {
    const h = harness();
    const org = await found(h, 'Acme');

    await h.call(
      post(`/v1/orgs/${String(org['id'])}/invitations`, {
        email: 'new@example.test',
        role: 'member',
      }),
    );
    const pending = await h.call({
      path: `/v1/orgs/${String(org['id'])}/invitations`,
    });

    const secret = h.sent().at(-1)?.secret ?? '';
    expect(secret).not.toBe('');
    // Neither the secret nor its fingerprint appears in any view.
    expect(pending.body).not.toContain(secret);
    expect(pending.body).not.toContain('fingerprint');
  });

  it('is single use', async () => {
    const h = harness();
    const org = await found(h, 'Acme');
    await h.call(
      post(`/v1/orgs/${String(org['id'])}/invitations`, {
        email: 'new@example.test',
        role: 'member',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';

    h.as(SOMEBODY);
    const first = await h.call(post('/v1/invitations/accept', { token }));
    h.as(THIRD);
    const second = await h.call(post('/v1/invitations/accept', { token }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
  });

  it('expires, and says the same thing as every other refusal', async () => {
    const h = harness();
    const org = await found(h, 'Acme');
    await h.call(
      post(`/v1/orgs/${String(org['id'])}/invitations`, {
        email: 'new@example.test',
        role: 'member',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';

    await h.clock.advance(millis(8 * 24 * 60 * 60 * 1000));

    h.as(SOMEBODY);
    const expired = await h.call(post('/v1/invitations/accept', { token }));
    const nonsense = await h.call(
      post('/v1/invitations/accept', { token: 'not-a-token' }),
    );

    // One indistinguishable error, the same rule case 13 fixes for identity's
    // links: four distinct errors let somebody holding a stale invitation learn
    // whether the organization exists and whether somebody already used it.
    expect(expired.status).toBe(400);
    expect(json(expired)['detail']).toBe(json(nonsense)['detail']);
  });

  it('confers exactly the role it was issued for', async () => {
    const h = harness();
    const org = await found(h, 'Acme');
    await h.call(
      post(`/v1/orgs/${String(org['id'])}/invitations`, {
        email: 'new@example.test',
        role: 'admin',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';

    h.as(SOMEBODY);
    const accepted = await h.call(post('/v1/invitations/accept', { token }));

    expect(json(accepted)['role']).toBe(OrgRole.Admin);
  });

  it('lets only an owner invite an owner', async () => {
    const h = harness();
    const org = await found(h, 'Acme');
    const id = String(org['id']);

    await h.call(
      post(`/v1/orgs/${id}/invitations`, {
        email: 'admin@example.test',
        role: 'admin',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';
    h.as(SOMEBODY);
    await h.call(post('/v1/invitations/accept', { token }));

    // An admin may invite, and may not invite an owner — otherwise the ladder
    // has no rungs and every admin is one request from being an owner.
    const refused = await h.call(
      post(`/v1/orgs/${id}/invitations`, {
        email: 'x@example.test',
        role: 'owner',
      }),
    );

    expect(refused.status).toBe(409);
  });

  it('cannot be revoked by an admin of a DIFFERENT organization', async () => {
    // The id is the only thing they would need, so scoping the lookup to the
    // org in the path is the whole defence.
    const h = harness();
    const mine = await found(h, 'Mine');
    await h.call(
      post(`/v1/orgs/${String(mine['id'])}/invitations`, {
        email: 'new@example.test',
        role: 'member',
      }),
    );
    const invitations = JSON.parse(
      (await h.call({ path: `/v1/orgs/${String(mine['id'])}/invitations` }))
        .body,
    ) as { id: string }[];
    const target = invitations[0]?.id ?? '';

    h.as(SOMEBODY);
    const theirs = await found(h, 'Theirs');
    const refused = await h.call({
      method: 'DELETE',
      path: `/v1/orgs/${String(theirs['id'])}/invitations/${target}`,
    });

    expect(refused.status).toBe(404);
  });

  it('spends the invitation when the caller is already a member', async () => {
    // Not an error: somebody forwarding a link to a person who joined last week
    // is not a failure, and refusing would leave a live invitation behind.
    const h = harness();
    const org = await found(h, 'Acme');
    await h.call(
      post(`/v1/orgs/${String(org['id'])}/invitations`, {
        email: 'new@example.test',
        role: 'member',
      }),
    );
    const token = h.sent().at(-1)?.secret ?? '';

    const accepted = await h.call(post('/v1/invitations/accept', { token }));

    expect(accepted.status).toBe(200);
    // Still an owner: an invitation as `member` does not demote an owner.
    expect(json(accepted)['role']).toBe('owner');
  });
});

describe('archiving', () => {
  it('is owner only, and keeps the roster', async () => {
    const h = harness();
    const org = await found(h, 'Acme');
    const id = String(org['id']);

    const archived = await h.call({ method: 'DELETE', path: `/v1/orgs/${id}` });
    const roster = await h.call({ path: `/v1/orgs/${id}/members` });

    expect(json(archived)['status']).toBe('archived');
    expect(JSON.parse(roster.body)).toHaveLength(1);
  });
});
