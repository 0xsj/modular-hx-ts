/**
 * The composition root. **The only place that knows concrete types.**
 *
 * `ARCHITECTURE.md` §3 rule 5: a context is reached only through its root, and
 * only by this file. Rules `S5` and `S6` keep everything else out, so this is
 * the one module that may see both `identity` and `audit` at once — and the one
 * that decides what is memory and what is PostgreSQL.
 *
 * **`CONTEXTS.md` §7.5: wire and serve before the third context.** A blueprint
 * in this collection passed every unit test and contract suite while every
 * route it declared returned 404, because handlers were written and the root
 * never mounted them and nothing in the test tree was shaped to notice.
 *
 * **What it announces.** A root that skips something says so at boot, with the
 * reason. That is how a slot nobody filled stops being invisible — `skipped`
 * below is logged by `serve`, and an empty list is the claim that nothing was
 * left out.
 */

import {
  type Authorizer,
  type Policy,
  type Subject,
  Scope,
  compilePolicy,
  makeAuthorizer,
  subject,
} from './shared/authz/index.js';
import { type Clock, type Sleeps } from './shared/clock/index.js';
import {
  type Keyring,
  ephemeralKeyring,
  makeMac,
} from './shared/crypto/index.js';
import { conditional } from './shared/conditional/index.js';
import {
  type Exchange,
  type Handler,
  json,
  text,
} from './shared/edge/index.js';
import {
  type Events,
  type Subscription,
  memoryEvents,
  outboxEvents,
  outboxMigrations,
} from './shared/events/index.js';
import { type BuildInfo, versionPayload } from './shared/buildinfo/index.js';
import { type Health, statusCode } from './shared/health/index.js';
import { chain } from './shared/httpx/index.js';
import { owns } from './shared/httproute/index.js';
import { type Documented } from './shared/openapi/index.js';
import { identityRoutes } from './contexts/identity/transport/http/routes.js';
import { auditRoutes } from './contexts/audit/transport/http/routes.js';
import { orgRoutes } from './contexts/orgs/transport/http/routes.js';
import { exportRoutes } from './contexts/exports/transport/http/routes.js';
import { type IdGenerator } from './shared/id/index.js';
import {
  idempotency,
  idempotencyMigrations,
  memoryRecords,
  postgresRecords,
} from './shared/idempotency/index.js';
import { type Logger } from './shared/logger/index.js';
import { type MigrationSet, type Postgres } from './shared/postgres/index.js';
import { makeOrigins } from './shared/provenance/index.js';
import { type Random } from './shared/random/index.js';
import {
  type ProxyTrust,
  memoryBucketStore,
  memoryBuckets,
  postgresBuckets,
  ratelimit,
  ratelimitMigrations,
} from './shared/ratelimit/index.js';
import { type Telemetry } from './shared/telemetry/index.js';
import { minutes } from './shared/clock/index.js';
import {
  auditMigrations,
  makeAudit,
  READ_RECORDS,
} from './contexts/audit/index.js';
import {
  GRANT_ROLE,
  REVOKE_ROLE,
} from './contexts/identity/app/command/roles.js';
import { UPDATE_USER } from './contexts/identity/app/command/update-user.js';
import { LIST_USERS } from './contexts/identity/app/query/list-users.js';
import {
  type IdentityDeps,
  identityMigrations,
  makeIdentity,
  noOrgs,
  Purpose,
  role,
} from './contexts/identity/index.js';
import { type Orgs, makeOrgs, orgsMigrations } from './contexts/orgs/index.js';
import { exportsMigrations, makeExports } from './contexts/exports/index.js';
import { makeWebhooks, webhooksMigrations } from './contexts/webhooks/index.js';
import { webhookRoutes } from './contexts/webhooks/transport/http/routes.js';
import {
  filesystemBlobs,
  memoryBlobStore,
  memoryBlobs,
} from './shared/blob/index.js';
import { operationsMigrations } from './shared/operations/index.js';
import { workMigrations, worker } from './shared/work/index.js';
import { type Caller } from './contexts/identity/app/query/caller.js';
import { smtpMailer, noopMailer } from './shared/mailer/index.js';
import { type Mailer } from './shared/mailer/index.js';
import { unwrap } from './shared/result/index.js';

/**
 * **The one policy, validated at boot.**
 *
 * Compiled here rather than in either context: `identity` names the permissions
 * it enforces and `audit` names the one it enforces, and *which roles get them*
 * is a product decision belonging to neither. `compilePolicy` returns a
 * `Result`, so a policy naming an action nobody defined fails the process
 * rather than becoming a 403 somebody debugs in production.
 */
export function appPolicy(): Policy {
  return unwrap(
    compilePolicy({
      admin: [
        { action: GRANT_ROLE, scope: Scope.Any },
        { action: REVOKE_ROLE, scope: Scope.Any },
        { action: READ_RECORDS, scope: Scope.Any },
        // An administrator edits anybody — §3.5's `PATCH /v1/users/{id}`,
        // which is also where enable and disable live.
        { action: UPDATE_USER, scope: Scope.Any },
        { action: LIST_USERS, scope: Scope.Any },
      ],
      auditor: [
        { action: READ_RECORDS, scope: Scope.Any },
        // Reading the directory is part of reading the trail: a record names an
        // actor by id, and an auditor who cannot resolve one is reading hex.
        { action: LIST_USERS, scope: Scope.Any },
      ],
      // Everybody authenticated: their own audit trail, their own profile, and
      // the directory. **`Own` on the update is what makes `PATCH /v1/me`'s
      // equivalent work without a second action** — a user owns themselves.
      member: [
        { action: READ_RECORDS, scope: Scope.Own },
        { action: UPDATE_USER, scope: Scope.Own },
        { action: LIST_USERS, scope: Scope.Any },
      ],
    }),
  );
}

/**
 * Every context's schema, in one set.
 *
 * A **value**, not something `wire` returns, because `migrate` runs as its own
 * command with no handler, no bus and no mailer — and the list must be the same
 * list either way. `MODULES.md` §3 namespaces them per context, so two contexts
 * can both have an `0001`.
 */
export const ALL_MIGRATIONS: MigrationSet = [
  // **Shared modules have tables too**, and this list held only the contexts.
  // The consequence was not an error at boot: `ratelimit` found no
  // `rate_limit_buckets`, failed *open* exactly as `I9` requires, degraded to a
  // per-process bucket and logged it — so a process that had silently stopped
  // rate limiting looked completely healthy. `idempotency` fails closed, so the
  // same omission there would have answered 503 to every request carrying a
  // key.
  ...outboxMigrations,
  ...idempotencyMigrations,
  ...ratelimitMigrations,
  ...identityMigrations,
  ...auditMigrations,
  ...orgsMigrations,
  ...operationsMigrations,
  ...workMigrations,
  ...exportsMigrations,
  ...webhooksMigrations,
  // `tenantMigrations` and `flagMigrations` are deliberately absent: neither
  // module is wired, and a migration for a table nothing reads is a table
  // somebody has to explain later.
];

/**
 * Every route this process can serve, with no dependencies constructed.
 *
 * **One list, and it is the one `wire` mounts.** `make openapi`, `make routes`
 * and `make curl` each kept their own copy of *which context tables exist*, and
 * the first time that mattered was the first time it was wrong: `exports`
 * landed with three routes and the committed spec did not change, because the
 * generator was walking a list that did not know about them. The drift check
 * cannot catch a route the generator never sees.
 *
 * Built with stub dependencies, which is safe for exactly the reason `openapi`
 * relies on: a route is a **value**, and nothing here calls a handler.
 */
export function allRoutes(): readonly Documented[] {
  return [
    ...identityRoutes({ deps: {} as IdentityDeps }, { defaultRoles: [] }),
    ...auditRoutes({ caller: () => undefined } as never),
    ...orgRoutes({ deps: {} as never, caller: () => undefined }),
    ...exportRoutes({ deps: {} as never, caller: () => undefined }),
    ...webhookRoutes({ deps: {} as never, caller: () => undefined }),
  ];
}

/**
 * Every context this list is supposed to cover.
 *
 * **A hand-maintained list of hand-maintained lists**, and it exists because
 * `allRoutes` has now been forgotten twice: once when `exports` landed and
 * `make openapi` published a spec missing four routes, and once when
 * `webhooks` landed and it published one missing eight. Both times the diff
 * `make ci` runs was clean — it compares the committed file against a generator
 * that was itself wrong, which is the failure mode of every check that
 * regenerates its own expectation.
 *
 * The rule test beside `S11` reads this against the directories under
 * `src/contexts/`, so the **next** context fails the build instead of being
 * quietly absent from the published contract.
 */
export const ROUTED_CONTEXTS: readonly string[] = [
  'identity',
  'audit',
  'orgs',
  'exports',
  'webhooks',
];

/** Something the root did not wire, and why. Logged at boot. */
export interface Skipped {
  readonly what: string;
  readonly why: string;
}

export interface WireOptions {
  /**
   * **`Sleeps` as well**, since `webhooks` was wired: `retry` waits, and a
   * module that both reads time and waits needs the two capabilities named
   * separately. `main` already passed a clock that does both — the narrower
   * type here was hiding it.
   */
  readonly clock: Clock & Sleeps;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly telemetry: Telemetry;
  readonly log: Logger;
  readonly health: Health;
  /** Served at `/version`, and named in every conformance report — §3.9. */
  readonly build: BuildInfo;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  readonly smtp?: { readonly host: string; readonly port: number };
  readonly tenant: string;
  /** Which proxies may speak for a caller. No default: `MODULES.md` §5. */
  readonly trust: ProxyTrust;
  readonly rateLimit: number;
  /** The per-process rate while the shared store is down. Absent is the full limit. */
  readonly degradedLimit?: number;
  /** Where export artifacts are written. Absent keeps them in memory. */
  readonly blobRoot?: string;
  /**
   * Mount `orgs`. **`false` is a working configuration, not a degraded one.**
   *
   * `CONTEXTS.md` §4 makes this the mechanical test that the cross-context port
   * is real: `identity` declares `OrgRoles` and does not implement it, `orgs`
   * satisfies it, and this file is the only one that sees both. If the process
   * did not boot and serve with `orgs` absent, the two would be coupled and the
   * port would be a formality — so the flag exists to be turned off, and
   * `tests/smoke/orgs-disabled.test.ts` turns it off.
   */
  readonly orgs?: boolean;
  /**
   * Mount `exports`. Absent means yes.
   *
   * The same seam `orgs` has: `exports` declares a `Datasets` port and this
   * file is the only thing that satisfies it, so turning the context off leaves
   * every other context untouched.
   */
  readonly exports?: boolean;
  /**
   * The MAC keyring. Absent mints an ephemeral one — see the note at the
   * `webhooks` wiring, which is the context that pays for it.
   */
  readonly keys?: Keyring;
  /**
   * Mount `webhooks`. Absent means yes.
   *
   * The first context that calls out of the process, so it is also the first
   * whose absence changes nothing anybody can observe from inside: with it off,
   * events are published and nothing listens.
   */
  readonly webhooks?: boolean;
}

/** The bootstrap administrator, from configuration. `CONTEXTS.md` §7.4. */
export interface Bootstrap {
  readonly email: string;
  readonly password: string;
}

export interface Wired {
  /** The whole HTTP surface, behind one chain. */
  readonly handler: Handler;
  /** Every context's migrations, in one set. */
  readonly migrations: MigrationSet;
  readonly events: Events;
  readonly subscriptions: readonly Subscription[];
  /** What was not wired, and why. Empty is a claim, not an absence. */
  readonly skipped: readonly Skipped[];
  readonly authorizer: Authorizer;
  /**
   * The export worker's loop, when `exports` is mounted.
   *
   * Returned rather than started here: `wire` builds a graph and `main` decides
   * what a process does with it — an API replica may serve without draining,
   * and both use the same wiring.
   */
  readonly worker?: {
    start(): Promise<void>;
    stop(): Promise<void>;
    drain(): Promise<number>;
  };
  /**
   * Mint the bootstrap administrator. **`CONTEXTS.md` §7.4.**
   *
   * Granting a role needs a role, so an empty database cannot reach one — the
   * base case of a recursive rule, and it belongs here rather than in
   * `identity`, because *which* role an operator bootstraps into is the same
   * product decision `appPolicy` above already makes.
   *
   * Refused when unset rather than defaulted: a well-known administrator
   * password is worse than no administrator, and a process that invents one is
   * a process every deploy ships with the same credential.
   */
  seed(bootstrap: Bootstrap): Promise<'created' | 'exists'>;
}

/**
 * The probes. Reachable without a credential, and not on any route table —
 * `health` is a shared module rather than a context, so the root is what knows
 * they exist.
 */
const PROBE_LIVE = '/healthz';
const PROBE_READY = '/readyz';
/**
 * **`/version`, and `CONFORMANCE.md` §3.9 is why it is mounted rather than
 * merely implemented.**
 *
 * `shared/buildinfo` has served this payload since it was written — the module's
 * own header says *served at `/version`* — and nothing mounted it. It answered
 * 404 for six phases while a function named `versionPayload` sat one import
 * away, which is the failure mode of a module that documents its caller instead
 * of having one.
 *
 * §3.9 makes it load-bearing: a conformance report has to name the binary it
 * measured, and the ports in this collection are adjacent enough that one
 * blueprint reported numbers taken from a sibling's server. A `/version` that
 * answers is how a reporter proves which process replied — so this is not a
 * convenience endpoint, it is the evidence.
 */
const PROBE_VERSION = '/version';
const PROBE_PATHS: readonly string[] = [PROBE_LIVE, PROBE_READY, PROBE_VERSION];

/**
 * Paths position 9 must not engage on: the ones a caller may reach anonymously.
 *
 * **Read off the route table rather than listed by hand.** `auth` is declared
 * per route on the shared registry, so the answer already exists — and a
 * hand-kept list is one that is wrong the first time somebody adds a route.
 * That was the shape of the first version of this file, and it was already
 * wrong: it named the login path for logout, which is a different path.
 *
 * The chain is process-wide and routing happens *below* position 9, so the
 * middleware cannot ask a route what it is — but the root can ask every route
 * before the process starts, which is the same answer computed once.
 */
function anonymousPaths(
  routes: readonly { readonly path: string; readonly auth: string }[],
): readonly string[] {
  return routes
    .filter((one) => one.auth === 'anonymous')
    .map((one) => one.path);
}

export function wire(options: WireOptions): Wired {
  const skipped: Skipped[] = [];
  const { clock, ids, random, telemetry, db } = options;

  const events: Events =
    db === undefined
      ? memoryEvents({
          clock,
          ids,
          // A failing subscriber must not veto the write, so the failure has
          // nowhere to go but a report.
          onFailure: (error) => {
            options.log.error('a subscriber failed', { err: error });
          },
        })
      : outboxEvents({ db, clock, ids, random, reporter: options.log });

  if (db === undefined) {
    skipped.push({
      what: 'outbox',
      why: 'STORAGE=memory — the in-process bus has nothing to make atomic',
    });
  }

  const smtp = options.smtp;
  const mailer: Mailer =
    smtp === undefined
      ? noopMailer(clock, ids)
      : smtpMailer({ host: smtp.host, port: smtp.port, clock, secure: false });

  if (smtp === undefined) {
    skipped.push({
      what: 'smtp',
      why: 'no SMTP host configured — links are minted and discarded, not delivered',
    });
  }

  const authorizer = makeAuthorizer(appPolicy());

  /**
   * Where artifacts live.
   *
   * A directory in memory mode and a directory on disk otherwise, because this
   * blueprint has no object-store account and `I1` says memory mode needs no
   * external dependency. S3 is the same port with a different `put` — a file
   * beside `filesystem.ts`, which is what `MODULES.md` §3 means.
   */
  const blobs =
    options.blobRoot === undefined
      ? memoryBlobs(memoryBlobStore(), clock)
      : filesystemBlobs({ root: options.blobRoot, clock });
  const origins = makeOrigins(ids);

  /**
   * S11's runtime half, and it **reports**.
   *
   * The rule test computes what the chain can produce; a handler returning a
   * status nobody declared is only visible while it happens. Refusing here
   * would break a correct response to enforce bookkeeping, so this says so
   * loudly and lets the answer through — and the loudness is the point, because
   * `openapi` is about to publish the declaration as the contract.
   */
  const onUndeclared = (
    route: { method: string; path: string },
    status: number,
  ): void => {
    options.log.error('a route answered a status it does not declare', {
      route: `${route.method} ${route.path}`,
      status,
      rule: 'S11',
    });
  };

  /**
   * **The wiring is circular; the calls are not.**
   *
   * `identity` needs `orgs`' memberships to build a caller, and `orgs` needs
   * `identity`'s authenticated caller to authorize a request. Neither imports
   * the other — the cycle is here, in the one file allowed to see both, and it
   * closes because both directions are **functions called later** rather than
   * values needed now.
   *
   * Held in a box rather than reordered around, because there is no order that
   * removes it: whichever is built first needs the other. Naming the cycle is
   * the honest version, and the closure below reads the box at **request**
   * time, by which point it is filled or deliberately empty.
   */
  const later: { orgs: Orgs | undefined } = { orgs: undefined };

  const identity = makeIdentity({
    onUndeclared,
    origins,
    // **The port, wired here and nowhere else.** `identity` declared it,
    // `orgs` satisfies it, and neither file names the other — `S6` holds
    // structurally rather than by inspection. `noOrgs` when the context is not
    // mounted, which is a working configuration.
    orgRoles: {
      of: (userId) =>
        later.orgs === undefined
          ? noOrgs.of(userId)
          : later.orgs.membershipsOf(userId),
    },
    // **Every signup is a `member`**, which is what makes `member` in the
    // policy above mean anything. Without it a registered user held no role,
    // and reading their own audit trail — the one thing the policy grants
    // everybody — answered 403. Named here because the policy is named here.
    defaultRoles: [role('member')],
    clock,
    ids,
    random,
    telemetry,
    publisher: events,
    authorizer,
    ...(db === undefined ? {} : { db }),
    mailer: {
      // The context names what a message *is*; `mailer` decides how it is sent.
      send: async (to, purpose, secret) => {
        const body = `Your ${purpose.replace('_', ' ')} link: ${secret}`;
        await mailer.send({
          to: [{ email: to }],
          from: { email: 'no-reply@example.invalid', name: 'Identity' },
          subject: subjectFor(purpose),
          text: body,
          html: `<p>${body}</p>`,
        });
      },
    },
  });

  /**
   * **The root lends `audit` identity's bearer auth** — `CONTEXTS.md` §3.
   *
   * Position 6 authenticated and set the actor on the provenance; this turns
   * that into an authz `Subject` carrying the caller's **own** roles. `audit`
   * never sees a token, which is what keeps `S6` true while still giving it an
   * authenticated principal.
   */
  const callerSubject = (exchange: Exchange): Subject | undefined => {
    const found = identityCaller(exchange);
    if (found === undefined) return undefined;
    return subject({
      actor: exchange.provenance.actor,
      roles: [...found.user.roles],
      ...(found.apiKey === undefined
        ? {}
        : { scopes: [...found.apiKey.scopes] }),
      tenant: options.tenant,
    });
  };

  /**
   * **The third context, and the first one another context needs.**
   *
   * Built before `identity` reads its port, because `identity` takes the port
   * as an option — which is the ordering the seam forces and the reason it is
   * visible here at all. Nothing below imports `orgs`; the root hands over one
   * function.
   */
  const orgs =
    options.orgs === false
      ? undefined
      : makeOrgs({
          clock,
          ids,
          random,
          publisher: events,
          caller: callerSubject,
          onUndeclared,
          ...(db === undefined ? {} : { db }),
          mailer: {
            send: async (to, org, secret) => {
              const body = `You have been invited to join ${org.name}. Your invitation token: ${secret}`;
              await mailer.send({
                to: [{ email: to }],
                from: {
                  email: 'no-reply@example.invalid',
                  name: 'Invitations',
                },
                subject: `Join ${org.name}`,
                text: body,
                html: `<p>${body}</p>`,
              });
            },
          },
        });

  later.orgs = orgs;

  if (orgs === undefined) {
    skipped.push({
      what: 'orgs',
      why: 'ORGS_ENABLED=false — every caller belongs to no organization, and identity`s OrgRoles port answers empty',
    });
  }

  const audit = makeAudit({
    onUndeclared,
    clock,
    ids,
    authorizer,
    caller: callerSubject,
    ...(db === undefined ? {} : { db }),
  });

  /**
   * **The dataset reader, and it is the seam again.** `exports` declares what
   * it needs — an async iterable of rows for a named dataset — and `S6` forbids
   * it importing `identity` or `audit` to get them. This file is the only thing
   * that sees both, exactly as with `OrgRoles`.
   *
   * A generator rather than an array: an export is bounded by the store, and a
   * reader that materialised every row would put the whole dataset in memory
   * before the streaming write ever started.
   */
  const datasets = {
    rows: (dataset: string, tenant: string) =>
      (async function* () {
        void tenant;
        if (dataset === 'users') {
          // Paged through the same query the API serves, so an export cannot
          // show a row the directory hides.
          let cursor: string | undefined;
          for (;;) {
            const page = await identity.listUsers({
              limit: 200,
              ...(cursor === undefined ? {} : { cursor }),
            });
            for (const row of page.items) yield row;
            if (page.next === undefined) return;
            cursor = page.next;
          }
        }
      })(),
  };

  const exports =
    options.exports === false
      ? undefined
      : makeExports({
          clock,
          ids,
          random,
          publisher: events,
          blobs,
          datasets,
          caller: callerSubject,
          onUndeclared,
          ...(db === undefined ? {} : { db }),
        });

  if (exports === undefined) {
    skipped.push({
      what: 'exports',
      why: 'EXPORTS_ENABLED=false — the routes are absent and nothing enqueues work',
    });
  }

  const webhooks =
    options.webhooks === false
      ? undefined
      : makeWebhooks({
          clock,
          ids,
          random,
          // **Ephemeral unless the root is given a keyring**, which is exactly
          // what `identity` and `orgs` do — and it has a consequence worth
          // naming here rather than discovering: a restart re-derives every
          // signing secret, so every receiver's stored `whsec_…` stops
          // verifying. That is survivable for a link that lives ten minutes
          // and it is not survivable for a webhook secret. `KEYRING` in
          // configuration is the fix, and it is the same fix for all three
          // contexts.
          mac: makeMac(options.keys ?? ephemeralKeyring(random)),
          publisher: events,
          caller: callerSubject,
          onUndeclared,
          ...(db === undefined ? {} : { db }),
        });

  if (webhooks === undefined) {
    skipped.push({
      what: 'webhooks',
      why: 'WEBHOOKS_ENABLED=false — nothing subscribes, and no event leaves the process',
    });
  }

  events.subscribe(audit.subscription);
  // **The fan-out is a subscriber like any other**, which is the property that
  // keeps `webhooks` from being special: it learns about an event the same way
  // `audit` does, and neither publisher knows either exists.
  if (webhooks !== undefined) events.subscribe(webhooks.subscription);

  // --- the chain ----------------------------------------------------------

  const buckets =
    db === undefined ? memoryBuckets(memoryBucketStore()) : postgresBuckets(db);

  const records = db === undefined ? memoryRecords(clock) : postgresRecords(db);

  skipped.push({
    what: 'deadline (chain position 5)',
    why: 'the module is not built; the budget is reachable and nothing spends it',
  });
  skipped.push({
    what: 'tenant (chain position 8)',
    why: `single-tenant: every request resolves to "${options.tenant}", which \`tenant\` requires to be byte-identical to no tenancy`,
  });

  const handler = chain(
    {
      clock,
      origins,
      telemetry,
      reporter: options.log,
      authenticate: identity.authenticate,
      resolveTenant: (exchange) => {
        exchange.provenance = exchange.provenance.withTenant(options.tenant);
      },
      ratelimit: ratelimit({
        buckets,
        clock,
        limit: { limit: options.rateLimit, window: minutes(1) },
        // Required, not defaulted — `MODULES.md` §5. `trustedProxies()` refuses
        // an absent setting at construction, which for a root means at boot.
        trust: options.trust,
        ...(options.degradedLimit === undefined
          ? {}
          : {
              degradedLimit: {
                limit: options.degradedLimit,
                window: minutes(1),
              },
            }),
        reporter: options.log,
      }),
      idempotency: idempotency({
        records,
        anonymousCallers: 'refused',
        // The seam. See `anonymousPaths`.
        exempt: [
          ...PROBE_PATHS,
          ...anonymousPaths([
            ...identity.routes,
            ...audit.routes,
            ...(orgs === undefined ? [] : orgs.routes),
            ...(exports === undefined ? [] : exports.routes),
            ...(webhooks === undefined ? [] : webhooks.routes),
          ]),
        ],
        reporter: options.log,
      }),
      conditional: conditional({
        // **Composed, because `conditional` takes one and there are now two.**
        // Until `orgs` existed there was exactly one implementer and the root
        // passed it straight through — which worked, and hid the fact that the
        // module's shape assumes a single owner of every tagged path.
        //
        // First match wins and the paths are disjoint, so the order is not a
        // policy. A third context sharing a path prefix with a second would
        // make it one, and that is the moment `conditional` should take a list
        // rather than a function. Raised, not pre-empted.
        validators: async (exchange) => {
          const found = await identity.validators(exchange);
          if (found !== undefined) return found;
          return orgs === undefined ? undefined : orgs.validators(exchange);
        },
      }),
    },
    dispatch({
      health: options.health,
      build: options.build,
      // **Ordered, and each one asked whether it owns the path.** The prefix
      // fold this replaced is exactly what `CONFORMANCE.md` §3.5 forbids: a
      // root that separates two contexts by `/identity/` versus `/audit/` has
      // put its architecture in the URL, and a client can read it there.
      tables: [
        { owns: owns(identity.routes), handler: identity.handler },
        ...(exports === undefined
          ? []
          : [{ owns: owns(exports.routes), handler: exports.handler }]),
        ...(webhooks === undefined
          ? []
          : [{ owns: owns(webhooks.routes), handler: webhooks.handler }]),
        { owns: owns(audit.routes), handler: audit.handler },
        ...(orgs === undefined
          ? []
          : [{ owns: owns(orgs.routes), handler: orgs.handler }]),
      ],
    }),
  );

  return {
    ...(exports === undefined
      ? {}
      : {
          worker: worker({
            queue: exports.queue,
            clock,
            handle: exports.handle,
            reporter: options.log,
          }),
        }),
    seed: (bootstrap) =>
      identity.ensureUser({
        email: bootstrap.email,
        password: bootstrap.password,
        // **Not `defaultRoles`.** A signup gets `member`; this is the account
        // that can grant one, and it is the only place `admin` is conferred
        // without an administrator already existing.
        roles: [role('admin')],
      }),
    handler,
    migrations: ALL_MIGRATIONS,
    events,
    subscriptions: [
      audit.subscription,
      ...(webhooks === undefined ? [] : [webhooks.subscription]),
    ],
    skipped,
    authorizer,
  };
}

/** The subject line for each purpose. Product copy, so it lives in the root. */
function subjectFor(purpose: string): string {
  switch (purpose) {
    case Purpose.VerifyEmail:
      return 'Confirm your email address';
    case Purpose.ResetPassword:
      return 'Reset your password';
    case Purpose.ChangeEmail:
      return 'Confirm your new email address';
    default:
      return 'Your sign-in link';
  }
}

/**
 * Which context serves a path.
 *
 * **Asked, not inferred.** Every context serves `/v1/*` — §3.5 — so there is no
 * prefix to fold on, and merging both route tables into one router here would
 * put routing knowledge in a third place and require one caller type for two
 * contexts that do not share one.
 *
 * Each table answers for itself, in order, using the same matcher its own
 * router uses. A table that owns the path keeps the request even when the
 * method is wrong, so a 405 stays a 405.
 *
 * The probes are the root's own, since `health` is a shared module rather than
 * a context.
 */
interface Table {
  readonly owns: (method: string, path: string) => boolean;
  readonly handler: Handler;
}

function dispatch(parts: {
  health: Health;
  build: BuildInfo;
  tables: readonly Table[];
}): Handler {
  return async (exchange: Exchange) => {
    const { method, path } = exchange.request;

    // **Never rate-limited, never idempotency-claimed** — both middlewares
    // exempt these, because throttling the endpoint an orchestrator polls turns
    // a traffic spike into a rolling restart.
    // `statusCode` is `health`'s own mapping, so the two probes cannot answer
    // differently from what the module already decided serving means.
    if (path === PROBE_LIVE) {
      const live = parts.health.live();
      return json(statusCode(live), live);
    }
    if (path === PROBE_READY) {
      const ready = await parts.health.ready();
      return json(statusCode(ready), ready);
    }
    // **Anonymous on purpose.** A caller who cannot yet authenticate is exactly
    // the caller who needs to know which build refused them, and the payload is
    // a name, a version and a commit — three things a deploy pipeline prints.
    if (path === PROBE_VERSION) {
      return json(200, versionPayload(parts.build));
    }

    for (const table of parts.tables) {
      if (table.owns(method, path)) return table.handler(exchange);
    }

    return text(404, '');
  };
}

/** Re-exported so `main` can log what the caller resolver reads. */
export { type Caller };

/**
 * Identity's per-request caller, read from where position 6 left it.
 *
 * Imported through the context root rather than reaching into its transport, so
 * `S2` holds: a context is reached through its root.
 */
import { callerOf as identityCaller } from './contexts/identity/transport/http/authn.js';
