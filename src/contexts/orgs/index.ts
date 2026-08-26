/**
 * The context root, and the only way in — `CONTEXTS.md` §8 step 6.
 *
 * `STORAGE=memory` when no `db` is passed: a real mode, not a demo.
 *
 * See `notes/domain/orgs.md`.
 */

import { type Subject } from '../../shared/authz/index.js';
import { type Clock } from '../../shared/clock/index.js';
import {
  type Keyring,
  ephemeralKeyring,
  makeMac,
} from '../../shared/crypto/index.js';
import { type Exchange, type Handler } from '../../shared/edge/index.js';
import { type Publisher } from '../../shared/events/index.js';
import { type IdGenerator } from '../../shared/id/index.js';
import { type Postgres } from '../../shared/postgres/index.js';
import { type Random } from '../../shared/random/index.js';
import { type AnyRoute } from '../../shared/httproute/index.js';
import { type OrgsDeps, type InvitationMailer } from './app/ports.js';
import {
  memoryReaders,
  memoryStore,
  memoryTransactor,
  type OrgStore,
} from './infra/memory/index.js';
import { postgresReaders, postgresTransactor } from './infra/postgres/index.js';
import { orgsMigrations } from './infra/postgres/schema.js';
import { orgRoutes, orgRouter } from './transport/http/routes.js';
import { orgValidators } from './transport/http/validators.js';
import { orgMemberships } from './app/query/roles.js';

/** One hour. An invitation is a standing offer sitting in a mailbox. */
const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrgsOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly publisher: Publisher;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  /** Tags invitations. Ephemeral when absent, which dev mode is entitled to. */
  readonly keys?: Keyring;
  readonly mailer: InvitationMailer;
  readonly invitationTtlMs?: number;
  /** The caller, as an authz `Subject` — the root lends identity's auth. */
  readonly caller: (exchange: Exchange) => Subject | undefined;
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
}

export interface Orgs {
  readonly deps: OrgsDeps;
  readonly handler: Handler;
  readonly routes: readonly AnyRoute<Subject>[];
  readonly migrations: typeof orgsMigrations;
  /** `conditional`'s validator — the second implementer, and the one that
   * showed the root has to compose them. */
  readonly validators: ReturnType<typeof orgValidators>;
  /**
   * **The port `identity` declares and this context satisfies.**
   *
   * `CONTEXTS.md` §4: *identity learns a caller's org roles through a port the
   * root wires, so neither context imports the other.* This is the satisfying
   * half; the declaring half is `identity/app/ports.ts`. Neither file names the
   * other, and `src/wire.ts` is the only thing that sees both.
   */
  readonly membershipsOf: (
    userId: string,
  ) => Promise<readonly { readonly orgId: string; readonly role: string }[]>;
  /** Only in memory mode, for a test that wants to look inside. */
  readonly store?: OrgStore;
}

export function makeOrgs(options: OrgsOptions): Orgs {
  const { db } = options;
  const backing =
    db === undefined
      ? (() => {
          const store = memoryStore();
          return {
            store,
            transactor: memoryTransactor({
              store,
              publisher: options.publisher,
            }),
            readers: memoryReaders(store),
          };
        })()
      : {
          store: undefined,
          transactor: postgresTransactor({ db, publisher: options.publisher }),
          readers: postgresReaders(db),
        };

  const { store, transactor, readers } = backing;

  const deps: OrgsDeps = {
    transactor,
    orgs: readers.orgs,
    memberships: readers.memberships,
    invitations: readers.invitations,
    mailer: options.mailer,
    mac: makeMac(options.keys ?? ephemeralKeyring(options.random)),
    clock: options.clock,
    ids: options.ids,
    random: options.random,
    publisher: options.publisher,
    invitationTtlMs: options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS,
  };

  const routes = orgRoutes({
    deps,
    caller: options.caller,
    ...(options.onUndeclared === undefined
      ? {}
      : { onUndeclared: options.onUndeclared }),
  });

  return {
    deps,
    routes,
    handler: orgRouter({
      deps,
      caller: options.caller,
      ...(options.onUndeclared === undefined
        ? {}
        : { onUndeclared: options.onUndeclared }),
    }),
    migrations: orgsMigrations,
    validators: orgValidators({
      orgs: readers.orgs,
      memberships: readers.memberships,
      caller: options.caller,
    }),
    membershipsOf: (userId) => orgMemberships(deps, userId),
    ...(store === undefined ? {} : { store }),
  };
}

export { orgsMigrations } from './infra/postgres/schema.js';
export { OrgRole, orgRole } from './domain/index.js';
export type { OrgsDeps, InvitationMailer } from './app/ports.js';
