/**
 * The `webhooks` domain, in one barrel.
 *
 * Same reason `operations` has one: the aggregates reference each other's ids
 * and the adapters import both, so a single entry point is what keeps
 * `no-circular` satisfiable.
 */

export {
  type Attempt,
  type DeliveryState_,
  Delivery,
  DeliveryState,
  MAX_ATTEMPTS,
  MAX_RECORDED,
} from './delivery.js';
export { checkDestination } from './destination.js';
export {
  type EndpointState_,
  DisabledBecause,
  Endpoint,
  EndpointState,
  FAILURES_BEFORE_DISABLE,
  noSuchEndpoint,
} from './endpoint.js';
export { WEBHOOK_PREFIX, WebhookEvent } from './events.js';
export {
  type DeliveryId,
  type EndpointId,
  deliveryId,
  endpointId,
} from './ids.js';
export {
  SIGNATURE_HEADERS,
  signatureHeader,
  signedMessage,
  timestampFor,
} from './signature.js';
