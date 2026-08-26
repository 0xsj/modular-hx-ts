/**
 * **`ORGS_ENABLED=false` boots and serves.** `../../CONTEXTS.md` §4.
 *
 * > Identity learns a caller\'s org roles through a port the root wires, so
 * > neither context imports the other, and `ORGS_ENABLED=false` is a working
 * > configuration.
 *
 * **This is the only mechanical test that the cross-context port is real.**
 * Everything else about the seam is visible by inspection and therefore
 * satisfiable in prose: `identity` declares `OrgRoles` and does not implement
 * it, `orgs` satisfies it, `S6` passes because neither imports the other. All
 * of that could be true of a port that is a formality — one whose absence
 * breaks the process, which would mean the contexts are coupled through
 * something the import graph cannot see.
 *
 * So this turns it off and asks the process to answer. A requirement satisfied
 * in a document and never executed is a requirement nobody has checked.
 *
 * `S9` exempts test files from *nothing imports the root* precisely so a
 * composition test like this one can exist.
 */

import { buildInfo } from '../../src/shared/buildinfo/index.js';
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../../src/shared/clock/index.js';
import { type Request } from '../../src/shared/edge/index.js';
import { makeHealth } from '../../src/shared/health/index.js';
import { fakeIds } from '../../src/shared/id/index.js';
import { jsonLogger } from '../../src/shared/logger/index.js';
import { systemRandom } from '../../src/shared/random/index.js';
import { NO_PROXIES } from '../../src/shared/ratelimit/index.js';
import { memoryTelemetry } from '../../src/shared/telemetry/index.js';
import { wire } from '../../src/wire.js';

function root(orgs: boolean, webhooks = true) {
  const clock = fakeClock();
  return wire({
    build: buildInfo({}),
    clock,
    ids: fakeIds(clock),
    random: systemRandom(),
    telemetry: memoryTelemetry(clock),
    log: jsonLogger({ clock, write: () => undefined }),
    health: makeHealth({ clock }),
    tenant: 'default',
    trust: NO_PROXIES,
    rateLimit: 120,
    orgs,
    webhooks,
  });
}

const request = (over: Partial<Request> = {}): never =>
  ({
    request: {
      method: 'GET',
      path: '/healthz',
      headers: {},
      query: {},
      peer: '127.0.0.1',
      body: () => Promise.resolve(''),
      ...over,
    },
  }) as never;

describe('with orgs disabled', () => {
  it('builds a working composition root', () => {
    // If the port were a formality this throws, and the throw is the finding.
    expect(() => root(false)).not.toThrow();
  });

  it('serves', async () => {
    const wired = root(false);

    const probe = await wired.handler(request());

    expect(probe.status).toBe(200);
  });

  it('answers identity`s routes exactly as before', async () => {
    // **The rest of the system does not change shape.** A caller belonging to
    // no organization is an ordinary caller, which is why `noOrgs` answers
    // empty rather than refusing.
    const wired = root(false);

    const registered = await wired.handler(
      request({
        method: 'POST',
        path: '/v1/users',
        headers: { 'content-type': 'application/json' },
        body: () =>
          Promise.resolve(
            JSON.stringify({
              email: 'nobody@example.test',
              password: 'a-perfectly-fine-password',
            }),
          ),
      }),
    );

    expect(registered.status).toBe(201);
  });

  it('answers 404 on an orgs route, not 500', async () => {
    // A context that is not mounted is a path nothing owns, which is a 404.
    // A 500 would mean the root still routed to something that is not there.
    const wired = root(false);

    const answer = await wired.handler(request({ path: '/v1/orgs' }));

    expect(answer.status).toBe(404);
  });

  it('says so at boot rather than being quietly absent', () => {
    // The announcement is what stops an unmounted context from being
    // invisible — the same rule that made `deadline` visible.
    const skipped = root(false).skipped.map((one) => one.what);

    expect(skipped).toContain('orgs');
  });
});

describe('with orgs enabled', () => {
  it('serves both, and does not announce a skip', async () => {
    const wired = root(true);

    const probe = await wired.handler(request());
    const orgs = await wired.handler(request({ path: '/v1/orgs' }));

    expect(probe.status).toBe(200);
    // 401 rather than 404: the route exists and wants a credential, which is
    // the difference between mounted and absent.
    expect(orgs.status).toBe(401);
    expect(wired.skipped.map((one) => one.what)).not.toContain('orgs');
  });
});

describe('with webhooks disabled', () => {
  // **The same question, for the context that reaches outward.** With it off,
  // events are published and nothing listens — so its absence is the least
  // observable of any context's, which is exactly why it needs asking rather
  // than assuming. A subscriber that the root cannot omit is a coupling the
  // import graph does not show.
  it('builds a working composition root', () => {
    expect(() => root(true, false)).not.toThrow();
  });

  it('serves, and says what is missing', async () => {
    const wired = root(true, false);

    const probe = await wired.handler(request());

    expect(probe.status).toBe(200);
    expect(wired.skipped.map((one) => one.what)).toContain('webhooks');
    // Never an empty reason: a skip nobody can explain is a skip nobody
    // notices.
    for (const one of wired.skipped) expect(one.why).not.toBe('');
  });

  it('stops subscribing, rather than subscribing to nothing', async () => {
    // The distinction that matters: the bus must not hold a handler that
    // silently drops events, because that looks identical to delivery until
    // somebody checks a receiver.
    const off = root(true, false);
    const on = root(true, true);

    expect(off.subscriptions).toHaveLength(on.subscriptions.length - 1);
    expect((await off.handler(request({ path: '/v1/webhooks' }))).status).toBe(
      404,
    );
    expect(
      (await on.handler(request({ path: '/v1/webhooks' }))).status,
    ).not.toBe(404);
  });
});
