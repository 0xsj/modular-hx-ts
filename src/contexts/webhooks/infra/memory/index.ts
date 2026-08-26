/**
 * The in-memory store. **`STORAGE=memory` is a real mode** — `I1`.
 *
 * Every refusal is a **rejection, not a throw**: a port method declared
 * `Promise<void>` that throws synchronously is one a caller cannot `.catch()`,
 * and the difference from the PostgreSQL adapter is invisible until a process
 * dies instead of recovering. Two other contexts in this repository shipped
 * that bug before it was noticed.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { type Queue } from '../../../../shared/work/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import {
  type Cursor,
  decodeCursor,
  paginate,
} from '../../../../shared/pagination/index.js';
import {
  type DeliveryId,
  type DeliveryState_,
  type EndpointId,
  type EndpointState_,
  Delivery,
  Endpoint,
} from '../../domain/index.js';
import {
  type Deliveries,
  type Endpoints,
  type Transactor,
  type Work,
} from '../../app/ports.js';

export interface WebhookStore {
  readonly endpoints: Map<string, EndpointState_>;
  readonly deliveries: Map<string, DeliveryState_>;
}

export function memoryStore(): WebhookStore {
  return { endpoints: new Map(), deliveries: new Map() };
}

export function memoryEndpoints(store: WebhookStore): Endpoints {
  const all = (): readonly EndpointState_[] => [...store.endpoints.values()];

  return {
    byId(id: EndpointId) {
      const row = store.endpoints.get(id);
      return Promise.resolve(
        row === undefined ? undefined : Endpoint.from(row),
      );
    },

    wanting(eventName) {
      return Promise.resolve(
        all()
          .filter((one) => one.state === 'enabled')
          .map((one) => Endpoint.from(one))
          // **The pattern match is the aggregate's**, not repeated here. The
          // PostgreSQL adapter cannot do that — it matches in SQL — and the
          // contract suite is what proves the two agree.
          .filter((one) => one.wants(eventName)),
      );
    },

    list(query) {
      const rows = all()
        .filter(
          (one) => query.ownerId === undefined || one.ownerId === query.ownerId,
        )
        .sort((a, b) => {
          const byTime = a.createdAt.getTime() - b.createdAt.getTime();
          return byTime === 0 ? a.id.localeCompare(b.id) : byTime;
        });

      const after = rows.filter(
        (one) => one.id > cursorId('webhooks.endpoints', query.cursor),
      );

      return Promise.resolve(
        unwrap(
          paginate(
            after.slice(0, query.limit + 1).map((one) => Endpoint.from(one)),
            query.limit,
            'webhooks.endpoints',
            (one) => one.id,
          ),
        ),
      );
    },

    create(endpoint) {
      const state = endpoint.toState();
      if (store.endpoints.has(state.id)) {
        return Promise.reject(conflict(`endpoint ${state.id} already exists`));
      }
      store.endpoints.set(state.id, state);
      return Promise.resolve();
    },

    save(endpoint) {
      const state = endpoint.toState();
      const current = store.endpoints.get(state.id);
      if (current?.version !== endpoint.baseVersion) {
        return Promise.reject(
          conflict(`endpoint ${state.id} was modified by somebody else`, {
            problem: 'version-conflict',
          }),
        );
      }
      store.endpoints.set(state.id, state);
      return Promise.resolve();
    },

    remove(id) {
      store.endpoints.delete(id);
      return Promise.resolve();
    },
  };
}

export function memoryDeliveries(store: WebhookStore): Deliveries {
  const all = (): readonly DeliveryState_[] => [...store.deliveries.values()];

  return {
    byId(id: DeliveryId) {
      const row = store.deliveries.get(id);
      return Promise.resolve(
        row === undefined ? undefined : Delivery.from(row),
      );
    },

    list(query) {
      // Newest first — a delivery log is read from the top.
      const rows = all()
        .filter((one) => one.endpointId === query.endpointId)
        .sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime();
          return byTime === 0 ? b.id.localeCompare(a.id) : byTime;
        });

      const from = cursorId('webhooks.deliveries', query.cursor);
      const after = from === '' ? rows : rows.filter((one) => one.id < from);

      return Promise.resolve(
        unwrap(
          paginate(
            after.slice(0, query.limit + 1).map((one) => Delivery.from(one)),
            query.limit,
            'webhooks.deliveries',
            (one) => one.id,
          ),
        ),
      );
    },

    create(delivery) {
      const state = delivery.toState();
      // **The same uniqueness the unique index enforces**, so the contract case
      // is a comparison rather than a coincidence: one delivery per event per
      // endpoint, because the bus is at-least-once.
      const already = all().some(
        (one) =>
          one.endpointId === state.endpointId && one.eventId === state.eventId,
      );
      if (already) {
        return Promise.reject(
          conflict('that event has already been queued for that endpoint'),
        );
      }
      store.deliveries.set(state.id, state);
      return Promise.resolve();
    },

    save(delivery) {
      const state = delivery.toState();
      const current = store.deliveries.get(state.id);
      if (current?.version !== delivery.baseVersion) {
        return Promise.reject(
          conflict(`delivery ${state.id} was modified by somebody else`, {
            problem: 'version-conflict',
          }),
        );
      }
      store.deliveries.set(state.id, state);
      return Promise.resolve();
    },

    removeForEndpoint(id) {
      for (const [key, row] of store.deliveries) {
        if (row.endpointId === id) store.deliveries.delete(key);
      }
      return Promise.resolve();
    },
  };
}

/**
 * The id a cursor points at.
 *
 * **Through `decodeCursor`, with the ordering name**, not by parsing the
 * base64 here. The first version of this did the latter and silently accepted
 * a cursor minted for a different ordering — which is the exact defect
 * conformance case 34 exists to catch, reintroduced in an adapter the case does
 * not reach. `unwrap` turns the refusal into the same `invalid` a real database
 * would raise, so both adapters refuse identically.
 */
function cursorId(order: string, cursor: Cursor | undefined): string {
  if (cursor === undefined) return '';
  const position = unwrap(decodeCursor(order, cursor));
  return typeof position === 'string' ? position : '';
}

export function memoryTransactor(options: {
  store: WebhookStore;
  publisher: Publisher;
  queue: Queue;
}): Transactor {
  const { store, publisher, queue } = options;

  return {
    async within<T>(work: (handle: Work) => Promise<T>): Promise<T> {
      const snapshot = {
        endpoints: new Map(store.endpoints),
        deliveries: new Map(store.deliveries),
      };

      const handle: Work = {
        endpoints: memoryEndpoints(store),
        deliveries: memoryDeliveries(store),
        queue,
        publish: async (event: Event, provenance: Provenance) => {
          await publisher.publish(event, provenance);
        },
        // **`undefined` is the honest value.** The memory adapters take no
        // writer, and the port's parameter is optional precisely so this is not
        // a lie about durability.
        writer: undefined,
      };

      try {
        return await work(handle);
      } catch (error) {
        store.endpoints.clear();
        for (const [k, v] of snapshot.endpoints) store.endpoints.set(k, v);
        store.deliveries.clear();
        for (const [k, v] of snapshot.deliveries) store.deliveries.set(k, v);
        throw error;
      }
    },
  };
}
