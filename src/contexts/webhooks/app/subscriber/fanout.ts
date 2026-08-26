/**
 * One event in, N deliveries out. **`webhooks` app · subscriber.**
 *
 * This is the seam that makes `webhooks` a *context* rather than an API for
 * poking a URL. It subscribes to `*` and, for each published event, asks the
 * repository which endpoints want it — then writes a delivery row and a queue
 * entry per endpoint, **in one transaction**.
 *
 * **The body is built once, here, and stored on the row.** Two reasons, and the
 * second is the one that bites:
 *
 * - A retry must send **byte-identical** bytes, because the signature covers
 *   them. Re-rendering from the envelope at attempt time means any change to
 *   the renderer — a field order, a date format — invalidates every signature
 *   in flight.
 * - Two endpoints subscribed to the same event get the **same body**, so a
 *   receiver comparing notes with another receiver sees one event, not two
 *   spellings of one.
 *
 * **A subscriber must not veto the publisher's write.** `events` is explicit
 * about this and it is doubly true here: a webhook endpoint being unreachable,
 * or the fan-out table being slow, must never fail the registration that
 * produced the event. What this throws, the bus dead-letters.
 */

import {
  type Envelope,
  type Subscription,
} from '../../../../shared/events/index.js';
import { Delivery, WEBHOOK_PREFIX, deliveryId } from '../../domain/index.js';
import { type WebhooksDeps } from '../ports.js';

/** The job kind the worker claims. Spelled once. */
export const DELIVER = 'webhooks.deliver';

/**
 * What a receiver gets.
 *
 * Deliberately **the envelope's own shape**, not a webhook-specific one: a
 * receiver reading `id`, `type`, `occurred_at` and `data` is reading the same
 * four things every other event consumer in this system reads. Inventing a
 * second vocabulary for the outside would mean two names for one event.
 */
export function renderBody(envelope: Envelope): string {
  return JSON.stringify({
    id: envelope.id,
    type: envelope.name,
    occurred_at: envelope.occurredAt.toISOString(),
    data: envelope.payload,
  });
}

export function fanoutSubscription(deps: WebhooksDeps): Subscription {
  return {
    // Everything, and the filtering is the repository's — see `wanting`.
    pattern: '*',
    // Stable across restarts, because at-least-once delivery identifies a
    // subscriber by a name that survives one.
    name: 'webhooks.fanout',
    handle: (envelope) => fanout(deps, envelope),
  };
}

export async function fanout(
  deps: WebhooksDeps,
  envelope: Envelope,
): Promise<void> {
  // **The loop guard, and it is enforced twice on purpose.** The domain refuses
  // a *subscription* to this prefix; this refuses the *fan-out* of one. Either
  // alone would be enough today, and neither alone survives somebody adding a
  // second way to create an endpoint.
  if (envelope.name.startsWith(WEBHOOK_PREFIX)) return;

  const wanting = await deps.endpoints.wanting(envelope.name);
  if (wanting.length === 0) return;

  const body = renderBody(envelope);
  const at = deps.clock.now();

  await deps.transactor.within(async (work) => {
    for (const endpoint of wanting) {
      const delivery = Delivery.queue(
        deliveryId(deps.ids.uuid()),
        endpoint.id,
        { id: envelope.id, name: envelope.name },
        body,
        at,
      );

      await work.deliveries.create(delivery, work.writer);
      // **The queue entry rides the same transaction**, which is `work`'s whole
      // reason for taking a writer: a delivery row with no job is a webhook
      // that silently never fires, and a job with no row is one that fails
      // forever on a lookup.
      await work.queue.enqueue(
        DELIVER,
        { deliveryId: delivery.id },
        envelope.provenance,
        at,
        work.writer,
      );
    }
  });
}
