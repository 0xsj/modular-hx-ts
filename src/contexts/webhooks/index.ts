/**
 * The context root, and the only way in — `CONTEXTS.md` §8 step 6.
 *
 * **The first context in this collection that talks to somebody else's
 * server.** `httpclient`, `breaker` and `retry` were built, tested and
 * referenced zero times from any context anywhere; this is what they were for.
 * Each of them still knows nothing about webhooks — the direction of the
 * dependency is the point.
 *
 * It also binds `work` a second time, which is the useful proof: a substrate
 * module used by exactly one context is a module shaped like that context.
 *
 * See `notes/domain/webhooks.md`.
 */

import { type Subject } from '../../shared/authz/index.js';
import { type Breaker, makeBreaker } from '../../shared/breaker/index.js';
import {
  type Clock,
  type Millis,
  type Sleeps,
  millis,
  seconds,
} from '../../shared/clock/index.js';
import { type Mac } from '../../shared/crypto/index.js';
import { type Exchange, type Handler } from '../../shared/edge/index.js';
import {
  type Publisher,
  type Subscription,
} from '../../shared/events/index.js';
import { type HttpClient, makeClient } from '../../shared/httpclient/index.js';
import { type AnyRoute, router } from '../../shared/httproute/index.js';
import { type IdGenerator } from '../../shared/id/index.js';
import { type Postgres } from '../../shared/postgres/index.js';
import { type Random } from '../../shared/random/index.js';
import { makeRetry } from '../../shared/retry/index.js';
import {
  type Job,
  type Queue,
  memoryQueue,
  memoryWorkStore,
  postgresQueue,
} from '../../shared/work/index.js';
import { type WebhooksDeps } from './app/ports.js';
import { DELIVER, fanoutSubscription } from './app/subscriber/fanout.js';
import { deliverOne } from './app/task/deliver.js';
import { endpointId } from './domain/index.js';
import {
  type WebhookStore,
  memoryDeliveries,
  memoryEndpoints,
  memoryStore,
  memoryTransactor,
} from './infra/memory/index.js';
import {
  postgresDeliveries,
  postgresEndpoints,
  postgresTransactor,
} from './infra/postgres/index.js';
import { webhooksMigrations } from './infra/postgres/schema.js';
import { derivedSecrets } from './infra/secrets.js';
import { webhookRoutes } from './transport/http/routes.js';

/**
 * Per **attempt**, never a total.
 *
 * Ten seconds is generous for a receiver that is up and ungenerous for one that
 * is hanging, which is the trade a webhook sender wants: a slow endpoint must
 * not be able to hold a worker for a minute, because it holds it for every
 * delivery at once.
 */
const DEFAULT_TIMEOUT = seconds(10);

/**
 * The backoff schedule, in minutes: 1, 5, 30, 120, 600.
 *
 * **A table rather than an exponent**, and read rather than computed, because
 * the numbers a receiver actually experiences are the specification. An owner
 * whose server was down for an hour gets four attempts spread across it and one
 * more the next morning.
 */
const SCHEDULE_MS: readonly number[] = [
  60_000, 300_000, 1_800_000, 7_200_000, 36_000_000,
];

export interface WebhooksOptions {
  /**
   * **`Sleeps` as well as `Clock`**, because `retry` waits.
   *
   * A module that both reads time and waits needs the two capabilities named
   * separately — `clock`'s own header says so — and asking for the pair here
   * rather than reaching for `setTimeout` is what lets a test drive a backoff
   * without spending the backoff.
   */
  readonly clock: Clock & Sleeps;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly mac: Mac;
  readonly publisher: Publisher;
  /** Absent selects `STORAGE=memory` — invariant `I1`, and a real mode. */
  readonly db?: Postgres;
  readonly caller: (exchange: Exchange) => Subject | undefined;
  readonly deliveryTimeoutMs?: Millis;
  /** Injected by tests; the real one is the platform's. */
  readonly fetch?: typeof globalThis.fetch;
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
}

export interface WebhooksContext {
  readonly deps: WebhooksDeps;
  readonly handler: Handler;
  readonly routes: readonly AnyRoute<Subject>[];
  readonly migrations: typeof webhooksMigrations;
  readonly queue: Queue;
  /** What a `work` worker calls. */
  readonly handle: (job: Job) => Promise<void>;
  /** Given to the bus by the root — `CONTEXTS.md` §8 step 5. */
  readonly subscription: Subscription;
  readonly breaker: Breaker;
  readonly store?: WebhookStore;
}

export function makeWebhooks(options: WebhooksOptions): WebhooksContext {
  const { clock, db } = options;

  const queue: Queue =
    db === undefined
      ? memoryQueue({ store: memoryWorkStore(), ids: options.ids })
      : postgresQueue({ db, ids: options.ids, random: options.random });

  const backing =
    db === undefined
      ? (() => {
          const store = memoryStore();
          return {
            store,
            endpoints: memoryEndpoints(store),
            deliveries: memoryDeliveries(store),
            transactor: memoryTransactor({
              store,
              queue,
              publisher: options.publisher,
            }),
          };
        })()
      : {
          store: undefined,
          endpoints: postgresEndpoints(db),
          deliveries: postgresDeliveries(db),
          transactor: postgresTransactor({
            db,
            publisher: options.publisher,
            ids: options.ids,
            random: options.random,
          }),
        };

  /**
   * **Per host, never global** — one dead receiver must not stop the others,
   * and this context is the reason `breaker` is keyed at all.
   */
  const breaker = makeBreaker(clock);

  const http: HttpClient = makeClient({
    clock,
    // `retry` handles a flapping socket **within** one attempt of a delivery;
    // the delivery's own schedule handles a receiver that is down. Two layers,
    // and conflating them is how a sender turns a receiver's bad minute into
    // thirty requests.
    retry: makeRetry(clock, options.random),
    breaker,
    timeout: options.deliveryTimeoutMs ?? DEFAULT_TIMEOUT,
    // **Two attempts, not three.** The default suits a service call inside a
    // request; a delivery is retried again in a minute anyway, so a third
    // immediate attempt buys almost nothing and costs a receiver a third
    // duplicate.
    attempts: 2,
    // A receiver's response body is not interesting and is not stored, so this
    // exists purely so a hostile one cannot exhaust a worker.
    maxBodyBytes: 64 * 1024,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const deps: WebhooksDeps = {
    transactor: backing.transactor,
    endpoints: backing.endpoints,
    deliveries: backing.deliveries,
    queue,
    http,
    secrets: derivedSecrets({
      mac: options.mac,
      random: options.random,
      fingerprintOf: async (id) =>
        (await backing.endpoints.byId(id))?.secretFingerprint,
    }),
    publisher: options.publisher,
    clock,
    ids: options.ids,
    deliveryTimeoutMs: options.deliveryTimeoutMs ?? DEFAULT_TIMEOUT,
    deliverKind: DELIVER,
    backoffFor: (attempt) =>
      millis(
        SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)] ??
          SCHEDULE_MS[SCHEDULE_MS.length - 1] ??
          60_000,
      ),
  };

  const routes = webhookRoutes({ deps, caller: options.caller });

  return {
    deps,
    routes,
    handler: router({
      routes,
      caller: options.caller,
      ...(options.onUndeclared === undefined
        ? {}
        : { onUndeclared: options.onUndeclared }),
    }),
    migrations: webhooksMigrations,
    queue,
    breaker,
    subscription: fanoutSubscription(deps),
    handle: async (job: Job) => {
      switch (job.kind) {
        case DELIVER: {
          const { deliveryId: id } = job.payload as { deliveryId: string };
          await deliverOne(deps, id, job.provenance);
          return;
        }
        default:
          // Not ours. A shared queue holding another context's job is not this
          // context's failure.
          return;
      }
    },
    ...(backing.store === undefined ? {} : { store: backing.store }),
  };
}

export { webhooksMigrations } from './infra/postgres/schema.js';
export { SIGNATURE_HEADERS, signedMessage } from './domain/index.js';
export type { WebhooksDeps } from './app/ports.js';
export { endpointId };
