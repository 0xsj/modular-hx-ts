/**
 * **S11 — a route answers only what it declares.** `../../ENFORCEMENT.md` S11.
 *
 * Read off the **real route tables**, not parsed out of source: routes are
 * values, and a rule that can build the thing it governs should. The tables are
 * constructed with stub dependencies because nothing here calls a handler — the
 * declaration is what is under test.
 *
 * This is a rule test rather than something `openapi` will notice later. The
 * declaration already exists and `openapi` will publish it as the contract, so
 * an undeclared status is a lie waiting to be printed, not a missing
 * annotation.
 */

import { describe, expect, it } from 'vitest';
import {
  type ChainShape,
  type Declared,
  undeclaredStatuses,
} from '../../src/shared/httproute/index.js';
import { type IdentityDeps } from '../../src/contexts/identity/index.js';
import { identityRoutes } from '../../src/contexts/identity/transport/http/routes.js';
import { auditRoutes } from '../../src/contexts/audit/transport/http/routes.js';

/**
 * The chain this repository's composition root builds.
 *
 * Stated here as data rather than reached for out of `wire()`, which would
 * need a database and a mailer to answer a question about declarations. The
 * cost is that the two can drift; the smoke test below pins the part that
 * matters — the exempt set is derived from `auth`, in both places.
 */
const CHAIN: ChainShape = {
  ratelimit: true,
  idempotency: true,
  conditional: true,
  guarded: true,
  exempt: [],
};

const identity = identityRoutes(
  { deps: {} as IdentityDeps },
  {
    defaultRoles: [],
  },
);

const audit = auditRoutes({
  // Never called: `auditRoutes` closes over these and the handler is not run.
  caller: () => undefined,
} as unknown as Parameters<typeof auditRoutes>[0]);

/** The exempt set the root computes, recomputed the same way. */
const exemptOf = (routes: readonly Declared[]): readonly string[] =>
  routes.filter((one) => one.auth === 'anonymous').map((one) => one.path);

describe('S11 — every status the chain can produce is declared', () => {
  it.each([
    ['identity', identity as readonly Declared[]],
    ['audit', audit as readonly Declared[]],
  ])('%s declares everything reachable through the chain', (_name, routes) => {
    const undeclared = undeclaredStatuses(routes, {
      ...CHAIN,
      exempt: exemptOf([...identity, ...audit] as readonly Declared[]),
      guarded: routes === identity,
    });

    expect(
      undeclared.map(
        (one) =>
          `${one.method} ${one.path} can answer ${String(one.status)} from ${one.from} and does not declare it`,
      ),
    ).toEqual([]);
  });

  it('exempts 500 and 503 rather than making every route repeat them', () => {
    // The one thing a rule like this gets wrong in the other direction: if the
    // globals were not exempt, every route would carry two statuses that say
    // nothing about it, and the declaration would stop being readable.
    const anyRoute = identity[0];
    if (anyRoute === undefined) throw new Error('no routes');

    expect(Object.keys(anyRoute.replies)).not.toContain('500');
    expect(Object.keys(anyRoute.replies)).not.toContain('503');
  });
});
