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
import { type Clock } from './shared/clock/index.js';
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
import { type Health, statusCode } from './shared/health/index.js';
import { chain } from './shared/httpx/index.js';
import { owns } from './shared/httproute/index.js';
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
  identityMigrations,
  makeIdentity,
  Purpose,
  role,
} from './contexts/identity/index.js';
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
  // `tenantMigrations` and `flagMigrations` are deliberately absent: neither
  // module is wired, and a migration for a table nothing reads is a table
  // somebody has to explain later.
];

/** Something the root did not wire, and why. Logged at boot. */
export interface Skipped {
  readonly what: string;
  readonly why: string;
}

export interface WireOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly telemetry: Telemetry;
  readonly log: Logger;
  readonly health: Health;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  readonly smtp?: { readonly host: string; readonly port: number };
  readonly tenant: string;
  /** Which proxies may speak for a caller. No default: `MODULES.md` §5. */
  readonly trust: ProxyTrust;
  readonly rateLimit: number;
  /** The per-process rate while the shared store is down. Absent is the full limit. */
  readonly degradedLimit?: number;
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
const PROBE_PATHS: readonly string[] = [PROBE_LIVE, PROBE_READY];

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

  const identity = makeIdentity({
    onUndeclared,
    origins,
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

  const audit = makeAudit({
    onUndeclared,
    clock,
    ids,
    authorizer,
    caller: callerSubject,
    ...(db === undefined ? {} : { db }),
  });

  events.subscribe(audit.subscription);

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
          ...anonymousPaths([...identity.routes, ...audit.routes]),
        ],
        reporter: options.log,
      }),
      conditional: conditional({ validators: identity.validators }),
    },
    dispatch({
      health: options.health,
      // **Ordered, and each one asked whether it owns the path.** The prefix
      // fold this replaced is exactly what `CONFORMANCE.md` §3.5 forbids: a
      // root that separates two contexts by `/identity/` versus `/audit/` has
      // put its architecture in the URL, and a client can read it there.
      tables: [
        { owns: owns(identity.routes), handler: identity.handler },
        { owns: owns(audit.routes), handler: audit.handler },
      ],
    }),
  );

  return {
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
    subscriptions: [audit.subscription],
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
