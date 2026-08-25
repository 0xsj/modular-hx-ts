/**
 * `audit`. **The context root, and the only way in.**
 *
 * Append-only. Subscribes to **every** context's domain events and records who
 * did what, to which subject, when, in which request and trace — §3.
 *
 * **Why it is in the constant set:** it is the proof that the event plumbing
 * works end to end, and it proves it **while importing nothing**. Rule `S6` is
 * not a constraint this context works around; it is the property being
 * demonstrated. Everything recorded arrived on an event, and the day something
 * cannot be recorded without a lookup is the day an *event* needs a field.
 *
 * Note: `notes/domain/audit.md`.
 */

import {
  type Authorizer,
  type Subject,
  denyAll,
} from '../../shared/authz/index.js';
import { type Clock } from '../../shared/clock/index.js';
import { type Exchange, type Handler } from '../../shared/edge/index.js';
import {
  type Subscriber,
  type Subscription,
} from '../../shared/events/index.js';
import { type IdGenerator } from '../../shared/id/index.js';
import { type Postgres } from '../../shared/postgres/index.js';
import { type AuditLog } from './app/ports.js';
import { auditSubscriber } from './app/subscriber/record.js';
import {
  type AuditStore,
  memoryAuditLog,
  memoryStore,
} from './infra/memory/index.js';
import { postgresAuditLog } from './infra/postgres/index.js';
import { auditMigrations } from './infra/postgres/schema.js';
import {
  auditRouter,
  type AuditRoute,
  auditRoutes,
} from './transport/http/routes.js';

export interface AuditOptions {
  /** Told when a route answers a status it never declared — S11. */
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  /** Absent is `denyAll`: an unwired policy reads nothing, never everything. */
  readonly authorizer?: Authorizer;
  /**
   * The caller, as an authz `Subject` — §3.
   *
   * **Lent by the composition root from identity's bearer auth.** `audit` never
   * resolves a token and never imports the context that owns one, which is how
   * a caller authenticated by one context authorizes a read in another.
   */
  readonly caller: (exchange: Exchange) => Subject | undefined;
}

export interface Audit {
  /** The read surface, ready to mount behind `httpx`'s chain. */
  readonly handler: Handler;
  /** Declared routes, for `openapi` to walk when it lands. */
  readonly routes: readonly AuditRoute[];
  /**
   * The subscription the root registers on the bus.
   *
   * **Registered, or the log stays empty and nothing says so.** A missing
   * subscription is a gap in the record that only shows up when somebody goes
   * looking for evidence.
   */
  readonly subscription: Subscription;
  readonly migrations: typeof auditMigrations;
  readonly log: AuditLog;
  /** Only in memory mode, for a test that wants to look inside. */
  readonly store?: AuditStore;
}

export function makeAudit(options: AuditOptions): Audit {
  const { db } = options;
  const backing =
    db === undefined
      ? (() => {
          const store = memoryStore();
          return { store, log: memoryAuditLog(store) };
        })()
      : { store: undefined, log: postgresAuditLog(db) };

  const { store, log } = backing;
  const authorizer = options.authorizer ?? denyAll;

  const deps = { log, authorizer, caller: options.caller };

  return {
    log,
    handler: auditRouter({
      ...deps,
      ...(options.onUndeclared === undefined
        ? {}
        : { onUndeclared: options.onUndeclared }),
    }),
    routes: auditRoutes(deps),
    subscription: auditSubscriber({
      log,
      clock: options.clock,
      ids: options.ids,
    }),
    migrations: auditMigrations,
    ...(store === undefined ? {} : { store }),
  };
}

/** Convenience for a root that has a bus in hand. */
export function subscribeAudit(bus: Subscriber, audit: Audit): void {
  bus.subscribe(audit.subscription);
}

export { type AuditLog } from './app/ports.js';
export { READ_RECORDS } from './app/query/search.js';
export { auditMigrations } from './infra/postgres/schema.js';
export {
  type AuditQuery,
  type AuditRecordState,
  AuditRecord,
} from './domain/index.js';
