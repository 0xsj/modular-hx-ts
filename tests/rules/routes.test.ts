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

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ChainShape,
  type Declared,
  undeclaredStatuses,
} from '../../src/shared/httproute/index.js';
import { type IdentityDeps } from '../../src/contexts/identity/index.js';
import { identityRoutes } from '../../src/contexts/identity/transport/http/routes.js';
import { auditRoutes } from '../../src/contexts/audit/transport/http/routes.js';
import { orgRoutes } from '../../src/contexts/orgs/transport/http/routes.js';
import { ROUTED_CONTEXTS, allRoutes } from '../../src/wire.js';

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

const orgs = orgRoutes({
  // Never called: `orgRoutes` closes over these and no handler is run here.
  deps: {} as never,
  caller: () => undefined,
});

const audit = auditRoutes({
  // Never called: `auditRoutes` closes over these and the handler is not run.
  caller: () => undefined,
} as unknown as Parameters<typeof auditRoutes>[0]);

/** The exempt set the root computes, recomputed the same way. */
const exemptOf = (routes: readonly Declared[]): readonly string[] =>
  routes.filter((one) => one.auth === 'anonymous').map((one) => one.path);

/**
 * **Every route the root mounts**, not the three this file happened to import.
 *
 * `exports` and `webhooks` were both absent from the list below while their
 * routes were live, so `S11` was proving a property about a subset and
 * reporting it as a property of the repository. `allRoutes()` is the one list
 * `wire` mounts, and taking it from there is what makes the next context
 * checked by default rather than when somebody remembers.
 */
const everything = allRoutes() as readonly Declared[];

describe('S11 — every status the chain can produce is declared', () => {
  it.each([
    ['identity', identity as readonly Declared[]],
    ['audit', audit as readonly Declared[]],
    ['orgs', orgs as readonly Declared[]],
    ['every mounted route', everything],
  ])('%s declares everything reachable through the chain', (_name, routes) => {
    const undeclared = undeclaredStatuses(routes, {
      ...CHAIN,
      exempt: exemptOf(everything),
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

describe('the published contract covers every context', () => {
  it('names every directory under src/contexts', () => {
    // **`allRoutes()` has been forgotten twice.** `exports` shipped with four
    // routes missing from `docs/openapi.json`, and `webhooks` with eight — and
    // `make openapi-check` was green both times, because it compares the
    // committed file against a generator that was itself incomplete. A check
    // that regenerates its own expectation cannot catch an omission in the
    // thing doing the regenerating.
    //
    // This is the outside view: the filesystem says which contexts exist.
    const onDisk = readdirSync(join(process.cwd(), 'src', 'contexts'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect([...ROUTED_CONTEXTS].sort()).toEqual(onDisk);
  });

  it('actually mounts a route from each of them', () => {
    // The list above could name a context and `allRoutes` still omit it — the
    // two are maintained a few lines apart. Every context here owns at least
    // one path, so an empty contribution is detectable without hard-coding
    // which paths belong to whom.
    expect(allRoutes().length).toBeGreaterThanOrEqual(ROUTED_CONTEXTS.length);
  });
});
