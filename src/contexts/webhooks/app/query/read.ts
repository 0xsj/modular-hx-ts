/**
 * Reads. **`webhooks` app · query.**
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { type Cursor, type Page } from '../../../../shared/pagination/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Delivery,
  type Endpoint,
  deliveryId,
  noSuchEndpoint,
} from '../../domain/index.js';
import { ownedBy } from '../command/endpoints.js';
import { type WebhooksDeps } from '../ports.js';

export interface ListOptions {
  readonly limit: number;
  readonly cursor?: Cursor;
}

/**
 * The caller's endpoints, and **only** the caller's.
 *
 * `ownerId` is not an optional filter a caller may widen — it is set here from
 * the subject. A list route that took an owner from the query string would let
 * anybody read anybody's integrations by changing one parameter, which is the
 * most common way this shape goes wrong.
 */
export function listEndpoints(
  deps: WebhooksDeps,
  subject: Subject,
  options: ListOptions,
): Promise<Page<Endpoint>> {
  return deps.endpoints.list({
    ownerId: subjectId(subject),
    limit: options.limit,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
}

export function readEndpoint(
  deps: WebhooksDeps,
  subject: Subject,
  id: string,
): Promise<Endpoint> {
  return ownedBy(deps, subject, id);
}

/** A delivery log, scoped to an endpoint the caller owns. */
export async function listDeliveries(
  deps: WebhooksDeps,
  subject: Subject,
  endpointRawId: string,
  options: ListOptions,
): Promise<Page<Delivery>> {
  const endpoint = await ownedBy(deps, subject, endpointRawId);

  return deps.deliveries.list({
    endpointId: endpoint.id,
    limit: options.limit,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });
}

/**
 * Send an exhausted delivery again.
 *
 * **The job is enqueued in the same transaction as the state change**, for the
 * reason every other enqueue in this repository is: a delivery flipped to
 * pending with no job is one that stays pending forever, and the owner who
 * pressed the button sees nothing happen and presses it again.
 */
export async function replayDelivery(
  deps: WebhooksDeps,
  subject: Subject,
  rawId: string,
  provenance: Provenance,
  deliverKind: string,
): Promise<Delivery> {
  const delivery = await deps.deliveries.byId(deliveryId(rawId));
  if (delivery === undefined) throw noSuchEndpoint();

  // Ownership is the **endpoint's**, checked the same way a read is — a
  // delivery id is not a capability.
  await ownedBy(deps, subject, delivery.endpointId);

  const at = deps.clock.now();
  delivery.replay(at);

  await deps.transactor.within(async (work) => {
    await work.deliveries.save(delivery, work.writer);
    await work.queue.enqueue(
      deliverKind,
      { deliveryId: delivery.id },
      provenance,
      at,
      work.writer,
    );
  });

  return delivery;
}
