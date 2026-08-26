/**
 * **Every chain position is mounted, or announced.** Nothing in between.
 *
 * A sibling shipped `ratelimit` finished and passing its own suite with chain
 * position 7 still a pass-through. Nothing was red: the module's tests called
 * the module, and the composition root's tests asserted that a request
 * succeeded — which it does, faster, with no limiter in it. That is a hole
 * green cannot see, and the only thing that can see it is a test that asks the
 * chain what it declared and the root what it filled.
 *
 * The rule this pins: **a declared position is either supplied or in
 * `skipped`.** Silence is the failure mode, and silence is what a pass-through
 * looks like from every other direction.
 */

import { buildInfo } from '../../src/shared/buildinfo/index.js';
import { describe, expect, it } from 'vitest';
import { memoryTelemetry } from '../../src/shared/telemetry/index.js';
import { systemClock } from '../../src/shared/clock/index.js';
import { systemIds } from '../../src/shared/id/index.js';
import { systemRandom } from '../../src/shared/random/index.js';
import { makeOrigins } from '../../src/shared/provenance/index.js';
import { makeHealth } from '../../src/shared/health/index.js';
import { jsonLogger } from '../../src/shared/logger/index.js';
import { NO_PROXIES } from '../../src/shared/ratelimit/index.js';
import { wire } from '../../src/wire.js';

/**
 * The optional positions `chain` declares, by the name `ChainOptions` uses.
 *
 * Written out rather than reflected off the type, because a type is erased and
 * the point is to fail when somebody **adds** a position and fills it nowhere.
 * Adding a row here is the second edit, the same way a layer map row is.
 */
const OPTIONAL_POSITIONS = [
  'deadline',
  'ratelimit',
  'idempotency',
  'conditional',
] as const;

const clock = systemClock();
const random = systemRandom();

function root() {
  return wire({
    build: buildInfo({}),
    clock,
    ids: systemIds(clock, (count) => random.bytes(count)),
    random,
    telemetry: memoryTelemetry(clock),
    // Written nowhere: this asserts on shape, and a smoke test that
    // printed a boot log would bury the reporter's own output.
    log: jsonLogger({ clock, write: () => undefined }),
    health: makeHealth({ clock }),
    tenant: 'default',
    trust: NO_PROXIES,
    rateLimit: 120,
  });
}

describe('the chain the root builds', () => {
  it('supplies or announces every optional position', () => {
    const wired = root();
    const announced = wired.skipped.map((one) => one.what);

    const unaccounted = OPTIONAL_POSITIONS.filter((position) => {
      const supplied = SUPPLIED.has(position);
      const named = announced.some((what) => what.startsWith(position));
      return !supplied && !named;
    });

    expect(
      unaccounted,
      'a position that is neither mounted nor in the skip list is a pass-through nobody can see',
    ).toEqual([]);
  });

  it('names a reason for everything it skipped', () => {
    // An entry with no reason is a skip list that has stopped being read.
    for (const gap of root().skipped) {
      expect(gap.what).not.toBe('');
      expect(gap.why.length).toBeGreaterThan(20);
    }
  });

  it('actually runs the positions it claims to mount', async () => {
    // **The half a skip list cannot prove.** `wire` could name a position and
    // hand `chain` an option it ignores; only a request can tell. A response
    // carrying `RateLimit-*` proves position 7 ran, and an `ETag` on a tagged
    // route proves position 9's second half did.
    const wired = root();

    const response = await wired.handler({
      request: {
        method: 'GET',
        path: '/v1/me',
        headers: {},
        query: {},
        peer: '127.0.0.1',
        body: () => Promise.resolve(''),
      },
      provenance: makeOrigins(
        systemIds(clock, (count) => random.bytes(count)),
      ).forBoot(),
      responseHeaders: {},
      remaining: () => 30_000,
    } as never);

    // Unauthenticated, which is the point: the refusal still carries position
    // 7's headers, so the limiter ran before authn refused.
    expect(response.status).toBe(401);
    expect(response.headers['ratelimit-limit']).toBe('120');
  });
});

/**
 * What `wire` hands `chain`.
 *
 * **Hand-kept, and therefore the weaker half of this file** — the same wart the
 * idempotency exempt list had before it was derived from the route table. It
 * catches a position added to `chain` and filled nowhere; it does **not** catch
 * `wire` handing over an option `chain` ignores, because both sides of that
 * mistake would be edited together.
 *
 * The probe below is the half with teeth: renaming the `ratelimit` key in
 * `wire` leaves this set unchanged and untouched, and fails the probe on the
 * next run. Deriving this from the running chain would need every position to
 * be observable from one request, which `deadline` and the idempotency claim
 * are not — so it is stated as a weaker check rather than dressed as a strong
 * one.
 */
const SUPPLIED = new Set(['ratelimit', 'idempotency', 'conditional']);
