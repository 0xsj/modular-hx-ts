/**
 * `identity`. **The context root, and the only way in.**
 *
 * `CONTEXTS.md` §8 step 6: one factory, wired by the composition root. Rule
 * `S5` keeps the shared layer from importing it and rule `S6` keeps every other
 * context out; this file is the whole surface either would reach for.
 *
 * **Ships full** — §2. Users, sessions, roles, credentials and the
 * emailed-secret lifecycle, exercising the entire vertical: transport →
 * validation → domain invariants → persistence → events → mail → authz.
 *
 * Note: `notes/domain/identity.md`.
 */

import { type Authorizer, denyAll, subject } from '../../shared/authz/index.js';
import { type Clock } from '../../shared/clock/index.js';
import { Kind, forbidden, kindOf } from '../../shared/errors/index.js';
import {
  type Keyring,
  ephemeralKeyring,
  makeMac,
} from '../../shared/crypto/index.js';
import { type Exchange, type Handler } from '../../shared/edge/index.js';
import { type Publisher } from '../../shared/events/index.js';
import { type Origins, makeOrigins } from '../../shared/provenance/index.js';
import { type IdGenerator } from '../../shared/id/index.js';
import { type Postgres } from '../../shared/postgres/index.js';
import { type Random } from '../../shared/random/index.js';
import { type Telemetry } from '../../shared/telemetry/index.js';
import { type Validators } from '../../shared/conditional/index.js';
import { type Role } from './domain/index.js';
import { register } from './app/command/register.js';
import {
  type Caller,
  type IdentityApp,
  type IdentityDeps,
  resolveCaller,
} from './app/index.js';
import { argon2Hasher } from './infra/hasher.js';
import {
  type IdentityStore,
  memoryReaders,
  memoryStore,
  memoryTransactor,
} from './infra/memory/index.js';
import { postgresReaders, postgresTransactor } from './infra/postgres/index.js';
import { identityMigrations } from './infra/postgres/schema.js';
import { callerOf, identityAuthenticator } from './transport/http/authn.js';
import { type AnyRoute, router } from '../../shared/httproute/index.js';
import { identityRoutes } from './transport/http/routes.js';
import { identityValidators } from './transport/http/validators.js';

export interface IdentityOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly telemetry: Telemetry;
  readonly publisher: Publisher;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  readonly sessionTtlMs?: number;
  /** Absent is `denyAll` — the safe default, not a placeholder. */
  readonly authorizer?: Authorizer;
  /** Tags challenges. Ephemeral when absent, which dev mode is entitled to. */
  readonly keys?: Keyring;
  /** Delivers emailed secrets. Required: there is no safe default. */
  readonly mailer: IdentityDeps['mailer'];
  readonly challengeTtlMs?: number;
  /**
   * Mints the origin `ensureUser` runs under. Defaults to its own.
   *
   * Optional because every other entry point already runs inside one — the
   * chain's position 1 puts it there — and only the bootstrap path, which has
   * no request above it, has to open one.
   */
  readonly origins?: Origins;
  /**
   * Told when a route answers a status it never declared — S11.
   *
   * Optional, and the root supplies it: what a process does about a contract
   * violation is the process's decision, not this context's.
   */
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
  /** Injected for tests that need a cheap hash; production takes the default. */
  readonly hasher?: IdentityDeps['hasher'];
  /**
   * Roles a self-registered user receives. **Absent is none.**
   *
   * The empty default is deliberate: a context that invented a role would be
   * deciding policy, and the process that compiled the policy is the only thing
   * that knows what the role means. See `transport/http/routes.ts`.
   */
  readonly defaultRoles?: readonly Role[];
}

export interface Identity extends IdentityApp {
  /** The HTTP surface, ready to mount behind `httpx`'s chain. */
  readonly handler: Handler;
  /** Declared routes, for `openapi` to walk when it lands. */
  readonly routes: readonly AnyRoute<Caller>[];
  /**
   * Position 6's authenticator, for the chain.
   *
   * **Mounted, or every event this context publishes names no actor.** See
   * `transport/http/authn.ts`.
   */
  readonly authenticate: (exchange: Exchange) => Promise<void>;
  /** `conditional`'s validator — this context is its first implementer. */
  readonly validators: Validators;
  readonly migrations: typeof identityMigrations;
  /** Only in memory mode, for a test that wants to look inside. */
  readonly store?: IdentityStore;
  /**
   * Create a user holding roles. **The bootstrap path, and not reachable over
   * HTTP** — no route calls it and none should.
   *
   * `CONTEXTS.md` §7.4: granting a role needs a role, so an empty database has
   * no way to reach one. That is the base case of a recursive rule, not a gap
   * in this context, and the fix belongs where bootstrapping belongs — which is
   * why this takes roles as an argument and has no opinion about which.
   *
   * It goes through `register`, the same command the public route uses, so the
   * account is a real user with a real hash rather than a row written behind
   * the domain's back. Idempotent by address: a second run reports `exists`.
   */
  ensureUser(input: EnsureUser): Promise<'created' | 'exists'>;
}

/** One hour. Short enough to bound a stolen token, long enough to be usable. */
const DEFAULT_TTL_MS = 60 * 60 * 1000;

/**
 * One hour for an emailed link, too.
 *
 * Shorter than the session it can create, because it is a bearer credential
 * sitting in a mailbox that may itself be compromised — and long enough to
 * survive a mail queue having a bad afternoon.
 */
const DEFAULT_CHALLENGE_TTL_MS = 60 * 60 * 1000;

/** What the bootstrap path needs. Roles are the caller's decision, not ours. */
export interface EnsureUser {
  readonly email: string;
  readonly password: string;
  readonly roles: readonly Role[];
}

export function makeIdentity(options: IdentityOptions): Identity {
  // Built as one branch rather than three, so the memory store's presence is a
  // fact the type system carries instead of one three separate `undefined`
  // checks have to agree about.
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

  const deps: IdentityDeps = {
    transactor,
    users: readers.users,
    sessions: readers.sessions,
    challenges: readers.challenges,
    apiKeys: readers.apiKeys,
    mailer: options.mailer,
    mac: makeMac(options.keys ?? ephemeralKeyring(options.random)),
    hasher: options.hasher ?? argon2Hasher(options.random),
    authorizer: options.authorizer ?? denyAll,
    clock: options.clock,
    ids: options.ids,
    random: options.random,
    telemetry: options.telemetry,
    sessionTtlMs: options.sessionTtlMs ?? DEFAULT_TTL_MS,
    challengeTtlMs: options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS,
  };

  const app: IdentityApp = { deps };
  const resolve = (token: string): Promise<Caller> =>
    resolveCaller(deps, token);

  const routes = identityRoutes(app, {
    defaultRoles: options.defaultRoles ?? [],
  });

  return {
    deps,
    routes,
    handler: router<Caller>({
      routes,
      // Position 6 resolved it; the registry reads what it found.
      caller: callerOf,
      // **Conformance case 16 lives here now**, not in the shared registry: a
      // key is refused unless the route opted in, so key management, logout and
      // password change are covered by the *default* rather than by three
      // remembered checks.
      ...(options.onUndeclared === undefined
        ? {}
        : { onUndeclared: options.onUndeclared }),
      guard: (found, who) => {
        if (who.apiKey !== undefined && found.meta?.['apiKeys'] !== 'allowed') {
          // `Forbidden`, not `Unauthenticated`: the credential is valid and the
          // caller identified — this endpoint does not accept this *kind*, and
          // a 401 would invite them to present it again.
          throw forbidden('an API key may not be used on this endpoint');
        }
      },
    }),
    authenticate: identityAuthenticator({ resolve }),
    validators: identityValidators({ users: readers.users, resolve }),
    migrations: identityMigrations,
    ...(store === undefined ? {} : { store }),

    async ensureUser(input: EnsureUser) {
      // The seed runs as a command, outside any request, so it opens its own
      // origin — `PROVENANCE.md`'s carriage rule at the one boundary a CLI has.
      const origin = (options.origins ?? makeOrigins(options.ids)).forCli(
        'seed',
      );

      try {
        await register(
          deps,
          // **A system subject, not a fabricated administrator.** `register`
          // takes one for `M4` and does not consult it; inventing a subject
          // holding `admin` here would be the weakening §7.4 forbids, arrived
          // at from the other direction.
          subject({
            actor: origin.actor,
            roles: [],
            tenant: origin.tenant ?? 'default',
          }),
          { email: input.email, password: input.password, roles: input.roles },
          origin,
        );
        return 'created';
      } catch (error) {
        // A duplicate address is the idempotent case, not a failure: the
        // command runs on every deploy and the second one has nothing to do.
        if (kindOf(error) === Kind.Conflict) return 'exists';
        throw error;
      }
    },
  };
}

export {
  type Caller,
  type IdentityApp,
  type IdentityDeps,
} from './app/index.js';
export { identityMigrations } from './infra/postgres/schema.js';
/**
 * The vocabulary the root needs to configure this context.
 *
 * Re-exported here rather than reached for inside `domain/` — `S2`: a context
 * is entered through its root, and that includes its words.
 */
export { type Role, Purpose, role } from './domain/index.js';
