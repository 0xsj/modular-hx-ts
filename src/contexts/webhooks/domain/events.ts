/**
 * What `webhooks` publishes. `<context>.<aggregate>.<past-tense-verb>` — §2.5.
 *
 * **These are events about deliveries, not the events being delivered.** The
 * distinction is the one thing a reader of this context has to hold: an
 * endpoint subscribes to `identity.user.registered`; the fact that a delivery
 * of it succeeded is `webhooks.delivery.succeeded`, and no endpoint should ever
 * subscribe to that — which is why `WEBHOOK_PREFIX` exists and is refused at
 * the boundary.
 */

export const WebhookEvent = {
  EndpointCreated: 'webhooks.endpoint.created',
  EndpointDisabled: 'webhooks.endpoint.disabled',
  EndpointEnabled: 'webhooks.endpoint.enabled',
  EndpointDeleted: 'webhooks.endpoint.deleted',
  SecretRotated: 'webhooks.endpoint.secret_rotated',
  DeliverySucceeded: 'webhooks.delivery.succeeded',
  DeliveryFailed: 'webhooks.delivery.failed',
  DeliveryExhausted: 'webhooks.delivery.exhausted',
} as const;

export type WebhookEvent = (typeof WebhookEvent)[keyof typeof WebhookEvent];

/**
 * **A subscription to this prefix is refused.** An endpoint that subscribes to
 * `webhooks.delivery.*` is one whose own delivery outcomes generate deliveries,
 * and a delivery that fails generates a failure event that generates a
 * delivery. The loop is not slow — it is one publish per attempt, growing.
 *
 * Cheap to forbid and expensive to notice, which is the whole argument.
 */
export const WEBHOOK_PREFIX = 'webhooks.';
