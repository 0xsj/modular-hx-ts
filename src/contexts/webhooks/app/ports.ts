/**
 * The out-ports. **Declared by `app/`, injected by the root** — `S8`.
 *
 * `webhooks` is the first context in this repository that talks to somebody
 * else's server, so it is the first whose out-ports include a **client** rather
 * than only stores. That is the whole reason it exists in the showcase:
 * `httpclient`, `breaker` and `retry` were built, tested and referenced zero
 * times from any context in the collection until this one.
 *
 * See `notes/domain/webhooks.md`.
 */

import { type Event, type Publisher } from '../../../shared/events/index.js';
import { type HttpClient } from '../../../shared/httpclient/index.js';
import { type Mac } from '../../../shared/crypto/index.js';
import { type Millis } from '../../../shared/clock/index.js';
import { type Provenance } from '../../../shared/provenance/index.js';
import { type Queue } from '../../../shared/work/index.js';
import { type Page, type Cursor } from '../../../shared/pagination/index.js';
import {
  type Delivery,
  type DeliveryId,
  type Endpoint,
  type EndpointId,
} from '../domain/index.js';

export interface EndpointQuery {
  readonly ownerId?: string;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface Endpoints {
  byId(id: EndpointId): Promise<Endpoint | undefined>;
  /**
   * Every **enabled** endpoint that wants this event.
   *
   * **The filter is here rather than in the caller**, because the caller would
   * have to load every endpoint in the installation to apply it — once per
   * published event. A repository that can answer *who wants this* answers it
   * with an index; one that cannot makes fan-out O(endpoints) per event.
   */
  wanting(eventName: string): Promise<readonly Endpoint[]>;
  list(query: EndpointQuery): Promise<Page<Endpoint>>;
  create(endpoint: Endpoint, writer?: unknown): Promise<void>;
  save(endpoint: Endpoint, writer?: unknown): Promise<void>;
  remove(id: EndpointId, writer?: unknown): Promise<void>;
}

export interface DeliveryQuery {
  readonly endpointId: EndpointId;
  readonly limit: number;
  readonly cursor?: Cursor;
}

export interface Deliveries {
  byId(id: DeliveryId): Promise<Delivery | undefined>;
  list(query: DeliveryQuery): Promise<Page<Delivery>>;
  create(delivery: Delivery, writer?: unknown): Promise<void>;
  save(delivery: Delivery, writer?: unknown): Promise<void>;
  /** Deliveries whose endpoint is gone. What `remove` leaves behind. */
  removeForEndpoint(id: EndpointId, writer?: unknown): Promise<void>;
}

/**
 * One unit of work.
 *
 * **The fan-out is the reason this is a transaction.** A published event
 * becomes N delivery rows and N queue entries, and a partial commit is either a
 * row nothing will ever pick up or a job whose row does not exist.
 */
export interface Work {
  readonly endpoints: Endpoints;
  readonly deliveries: Deliveries;
  readonly queue: Queue;
  publish(event: Event, provenance: Provenance): Promise<void>;
  readonly writer: unknown;
}

export interface Transactor {
  within<T>(work: (handle: Work) => Promise<T>): Promise<T>;
}

/**
 * The secret an endpoint signs with.
 *
 * **Two operations, and the store never hands the secret back to this
 * context.** `sign` happens inside whatever holds the key; what this context
 * keeps is a fingerprint, which is enough to tell two secrets apart and useless
 * for forging one. The same shape `identity` uses for passwords, and the reason
 * a leaked `webhooks` table is not a set of forgeable signatures.
 */
export interface Secrets {
  /** A fresh secret. Returns what to store and what to show the owner ONCE. */
  mint(): Promise<{ readonly fingerprint: string; readonly reveal: string }>;
  sign(endpoint: EndpointId, message: string): Promise<string>;
}

export interface WebhooksDeps {
  readonly transactor: Transactor;
  readonly endpoints: Endpoints;
  readonly deliveries: Deliveries;
  readonly queue: Queue;
  readonly http: HttpClient;
  readonly secrets: Secrets;
  readonly publisher: Publisher;
  readonly clock: { now(): Date };
  readonly ids: { uuid(): string };
  /** Per attempt, handed to `httpclient`. Never a total. */
  readonly deliveryTimeoutMs: Millis;
  /** Backoff for the *next* attempt, given how many have been spent. */
  backoffFor(attempt: number): Millis;
  /**
   * The job kind a retry is enqueued under.
   *
   * Passed rather than imported, because the task that enqueues the next
   * attempt would otherwise import the subscriber that defines the constant,
   * and `app/task` importing `app/subscriber` is a circle waiting for a third
   * caller.
   */
  readonly deliverKind: string;
}

export type { Mac };
