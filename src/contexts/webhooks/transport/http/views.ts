/**
 * What `webhooks` puts on the wire. Snake case — `CONFORMANCE.md` §3.5.
 *
 * **Field by field, never a spread.** `exports` published `contentType` on a
 * snake_case wire by writing `result: operation.result`, and a spread is
 * precisely the operation that declines to look at what it is copying. Nothing
 * here is copied wholesale from a domain value.
 */

import {
  type Attempt,
  type Delivery,
  type Endpoint,
} from '../../domain/index.js';

export interface EndpointView {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly state: string;
  readonly disabled_because?: string;
  readonly consecutive_failures: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly version: number;
}

export function endpointView(endpoint: Endpoint): EndpointView {
  return {
    id: endpoint.id,
    url: endpoint.url,
    events: endpoint.events,
    state: endpoint.state,
    ...(endpoint.disabledBecause === undefined
      ? {}
      : { disabled_because: endpoint.disabledBecause }),
    consecutive_failures: endpoint.consecutiveFailures,
    created_at: endpoint.createdAt.toISOString(),
    updated_at: endpoint.updatedAt.toISOString(),
    version: endpoint.version,
    // **The fingerprint is not here.** It identifies the secret, and publishing
    // it lets anybody who has seen one response confirm a guess offline.
  };
}

export interface AttemptView {
  readonly at: string;
  readonly status?: number;
  readonly error?: string;
  readonly took_ms: number;
}

function attemptView(attempt: Attempt): AttemptView {
  return {
    at: attempt.at.toISOString(),
    ...(attempt.status === undefined ? {} : { status: attempt.status }),
    ...(attempt.error === undefined ? {} : { error: attempt.error }),
    took_ms: attempt.tookMs,
  };
}

export interface DeliveryView {
  readonly id: string;
  readonly endpoint_id: string;
  readonly event_id: string;
  readonly event: string;
  readonly state: string;
  readonly attempts: readonly AttemptView[];
  readonly total_attempts: number;
  readonly next_attempt_at?: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export function deliveryView(delivery: Delivery): DeliveryView {
  return {
    id: delivery.id,
    endpoint_id: delivery.endpointId,
    event_id: delivery.eventId,
    event: delivery.eventName,
    state: delivery.state,
    attempts: delivery.attempts.map(attemptView),
    total_attempts: delivery.attemptCount,
    ...(delivery.nextAttemptAt === undefined
      ? {}
      : { next_attempt_at: delivery.nextAttemptAt.toISOString() }),
    created_at: delivery.createdAt.toISOString(),
    updated_at: delivery.updatedAt.toISOString(),
    // **The payload is not here.** It is somebody else's event body, it can be
    // large, and a delivery log that echoes it turns one leak into two.
  };
}
