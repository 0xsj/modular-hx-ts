/**
 * Send one delivery. **`webhooks` app · task.**
 *
 * The worker claims a job, this runs, and the outcome is written to the row.
 * Everything hard about talking to somebody else's server is **already
 * solved one layer down** — `httpclient` owns the per-attempt timeout, the
 * capped read, the status→`Kind` mapping and the breaker; `retry` owns the
 * backoff schedule. This file owns exactly three decisions the substrate cannot
 * make:
 *
 * - **What to sign, and with which secret.** Only this context knows the
 *   delivery id belongs in the signed message.
 * - **Whether an outcome is a failure.** `httpclient` reports a 4xx as an
 *   error; for a webhook, a 410 Gone is a *destination telling us to stop*, and
 *   treating it as a transient failure means five more attempts at a URL that
 *   has explicitly retired.
 * - **What a failure costs the endpoint.** A delivery is retried; an endpoint
 *   that has failed twenty times running is disabled.
 *
 * **The two clocks stay separate.** `deps.backoffFor` computes the interval and
 * `deps.clock.now()` supplies the instant — `../../../../MODULES.md` §L1 forbids
 * computing an interval from a reading a module took itself, and a delivery
 * whose cooldown is wall-clock arithmetic is one that a clock adjustment can
 * hold open or release early.
 */

import { isCircuitRejection } from '../../../../shared/breaker/index.js';
import { type Result, isOk } from '../../../../shared/result/index.js';
import { type HttpResponse } from '../../../../shared/httpclient/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Attempt,
  type Delivery,
  DisabledBecause,
  SIGNATURE_HEADERS,
  WebhookEvent,
  deliveryId,
  signatureHeader,
  signedMessage,
  timestampFor,
} from '../../domain/index.js';
import { type WebhooksDeps } from '../ports.js';

/**
 * Statuses that mean **stop**, not **try again**.
 *
 * `410 Gone` is the specified way for a receiver to retire an endpoint, and
 * honouring it is the difference between a good citizen and a service that
 * keeps knocking. `404` is here for the same reason with less ceremony — a URL
 * that does not exist will not start existing on attempt four.
 *
 * Everything else 4xx is *not* here on purpose: a 401 usually means a secret
 * was rotated on their side and will be fixed, a 429 is explicitly temporary,
 * and a 400 is often a receiver deploying a bad parser for ten minutes.
 */
const RETIRING: readonly number[] = [404, 410];

export interface DeliveryOutcome {
  readonly delivered: boolean;
  readonly status?: number;
  readonly exhausted: boolean;
  readonly endpointDisabled: boolean;
}

export async function deliverOne(
  deps: WebhooksDeps,
  rawId: string,
  provenance: Provenance,
): Promise<DeliveryOutcome> {
  const id = deliveryId(rawId);
  const delivery = await deps.deliveries.byId(id);

  // **A missing or finished delivery is not an error.** The queue is
  // at-least-once, so a job whose worker died after the write is redelivered
  // and must find nothing to do rather than throw — a throw here would retry
  // the job, fail identically, and eventually dead-letter a delivery that
  // actually succeeded.
  if (delivery === undefined || delivery.isTerminal) {
    return { delivered: false, exhausted: false, endpointDisabled: false };
  }

  const endpoint = await deps.endpoints.byId(delivery.endpointId);
  if (endpoint === undefined) {
    return { delivered: false, exhausted: false, endpointDisabled: false };
  }
  // **A disabled endpoint is not attempted**, and the delivery stays pending:
  // re-enabling should send what was missed rather than silently discard it.
  if (!endpoint.isEnabled) {
    return { delivered: false, exhausted: false, endpointDisabled: true };
  }

  const startedAt = deps.clock.now();
  const timestamp = timestampFor(startedAt);
  const signature = await deps.secrets.sign(
    endpoint.id,
    signedMessage(delivery.id, timestamp, delivery.payload),
  );

  const sent = await deps.http.send({
    method: 'POST',
    url: endpoint.url,
    headers: {
      'content-type': 'application/json',
      // **The delivery id, and it is stable across every retry** — which is
      // what makes it usable as an idempotency key by the receiver. An id that
      // changed per attempt would make five retries look like five events.
      [SIGNATURE_HEADERS.Id]: delivery.id,
      [SIGNATURE_HEADERS.Timestamp]: String(timestamp),
      [SIGNATURE_HEADERS.Signature]: signatureHeader(signature),
      'webhook-event': delivery.eventName,
    },
    body: delivery.payload,
    timeout: deps.deliveryTimeoutMs,
    // **Not forwarded.** `forwardActor` would tell an arbitrary third party
    // which of our users caused the event, which is an identifier leak for
    // nothing they can verify or act on.
  });

  const finishedAt = deps.clock.now();
  const attempt = describe(sent, startedAt, finishedAt);

  return settle(deps, delivery, attempt, provenance);
}

function describe(
  sent: Result<HttpResponse>,
  startedAt: Date,
  finishedAt: Date,
): Attempt & { readonly ok: boolean; readonly retiring: boolean } {
  const tookMs = finishedAt.getTime() - startedAt.getTime();

  if (isOk(sent)) {
    return {
      at: finishedAt,
      status: sent.value.status,
      tookMs,
      ok: true,
      retiring: false,
    };
  }

  const error: unknown = sent.error;
  const status = statusOf(error);

  return {
    at: finishedAt,
    ...(status === undefined ? {} : { status }),
    // **The reason, never their body.** `httpclient` already refuses to put an
    // upstream body in a message; repeating the rule here is what keeps a
    // receiver's error page out of our database and out of our logs.
    error: reasonFor(error),
    tookMs,
    ok: false,
    retiring: status !== undefined && RETIRING.includes(status),
  };
}

function statusOf(error: unknown): number | undefined {
  const details = (error as { details?: { status?: unknown } }).details;
  return typeof details?.status === 'number' ? details.status : undefined;
}

function reasonFor(error: unknown): string {
  // A circuit rejection is **not** the endpoint's failure — it is ours, and
  // saying so is the difference between an owner debugging their server and an
  // owner reading that we stopped calling it for a minute.
  if (isCircuitRejection(error)) return 'not attempted: circuit open';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'delivery failed';
}

async function settle(
  deps: WebhooksDeps,
  delivery: Delivery,
  attempt: Attempt & { readonly ok: boolean; readonly retiring: boolean },
  provenance: Provenance,
): Promise<DeliveryOutcome> {
  const endpoint = await deps.endpoints.byId(delivery.endpointId);
  if (endpoint === undefined) {
    return { delivered: false, exhausted: false, endpointDisabled: false };
  }

  const at = attempt.at;
  let exhausted = false;
  let endpointDisabled = false;

  if (attempt.ok) {
    delivery.succeed(attempt);
    endpoint.succeeded(at);
  } else if (attempt.retiring) {
    // **Straight to exhausted.** A 410 means *stop*, and five more attempts at
    // a retired URL is the behaviour that gets a sender blocked.
    while (!delivery.isTerminal) {
      delivery.fail(attempt, at);
    }
    exhausted = true;
    endpointDisabled = endpoint.failed(at).disabled;
  } else {
    const outcome = delivery.fail(
      attempt,
      new Date(at.getTime() + deps.backoffFor(delivery.attemptCount)),
    );
    exhausted = outcome.exhausted;
    endpointDisabled = endpoint.failed(at).disabled;
  }

  await deps.transactor.within(async (work) => {
    await work.deliveries.save(delivery, work.writer);
    await work.endpoints.save(endpoint, work.writer);

    // **The next attempt is enqueued here, or there is no next attempt.**
    //
    // This was missing, and the bug it caused is the one a webhook sender
    // cannot survive: a failed delivery was written as `pending` with a
    // `next_attempt_at` that *nothing read*. The row said *we will try again
    // in a minute*, the delivery log showed it, and the job that had just run
    // completed successfully — so the queue was empty and the retry never
    // happened. Every attempt-counting test passed, because they all drove
    // `deliverOne` directly.
    //
    // The delivery's schedule is the queue's schedule. `work` takes the
    // instant, so the backoff computed above is what the worker waits for, and
    // the enqueue rides the same transaction as the state that justified it.
    const retryAt = delivery.nextAttemptAt;
    if (retryAt !== undefined && !delivery.isTerminal) {
      await work.queue.enqueue(
        deps.deliverKind,
        { deliveryId: delivery.id },
        provenance,
        retryAt,
        work.writer,
      );
    }

    await work.publish(
      {
        name: attempt.ok
          ? WebhookEvent.DeliverySucceeded
          : exhausted
            ? WebhookEvent.DeliveryExhausted
            : WebhookEvent.DeliveryFailed,
        payload: {
          subject: delivery.id,
          endpointId: endpoint.id,
          event: delivery.eventName,
          attempt: delivery.attemptCount,
          ...(attempt.status === undefined ? {} : { status: attempt.status }),
        },
      },
      provenance,
    );

    if (endpointDisabled) {
      await work.publish(
        {
          name: WebhookEvent.EndpointDisabled,
          payload: {
            subject: endpoint.id,
            by: DisabledBecause.ConsecutiveFailures,
          },
        },
        provenance,
      );
    }
  });

  return {
    delivered: attempt.ok,
    ...(attempt.status === undefined ? {} : { status: attempt.status }),
    exhausted,
    endpointDisabled,
  };
}
