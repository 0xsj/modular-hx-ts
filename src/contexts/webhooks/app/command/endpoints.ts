/**
 * Register, redirect, rotate, disable, delete. **`webhooks` app · command.**
 *
 * Ownership is the whole authorization model here and it is deliberately
 * simple: **an endpoint belongs to the subject that registered it**, and only
 * that subject may see or change it. There is no sharing, no per-endpoint
 * grant, and no administrator override — an operator who needs to disable
 * somebody's endpoint does it in the database, which is a worse experience and
 * a much better default than a route that can read every integration in the
 * installation.
 *
 * See `notes/domain/webhooks.md`.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Endpoint,
  type EndpointId,
  DisabledBecause,
  Endpoint as EndpointAggregate,
  WebhookEvent,
  endpointId,
  noSuchEndpoint,
} from '../../domain/index.js';
import { type WebhooksDeps } from '../ports.js';

export interface RegisterInput {
  readonly url: string;
  readonly events: readonly string[];
}

export interface Registered {
  readonly endpoint: Endpoint;
  /**
   * The secret, in the clear. **Returned once and never again.**
   *
   * The store holds a fingerprint, so this value cannot be recovered — a caller
   * that loses it rotates. That is a worse afternoon for one integrator and the
   * reason a leaked table is not a set of forgeable signatures.
   */
  readonly secret: string;
}

export async function registerEndpoint(
  deps: WebhooksDeps,
  subject: Subject,
  input: RegisterInput,
  provenance: Provenance,
): Promise<Registered> {
  const at = deps.clock.now();
  const id = endpointId(deps.ids.uuid());
  const minted = await deps.secrets.mint();

  // **The domain checks the destination**, not this function — a URL that
  // reaches registration through some other path must get the same refusal.
  const endpoint = EndpointAggregate.register(
    id,
    subjectId(subject),
    input.url,
    input.events,
    minted.fingerprint,
    at,
  );

  await deps.transactor.within(async (work) => {
    await work.endpoints.create(endpoint);
    await work.publish(
      {
        name: WebhookEvent.EndpointCreated,
        payload: {
          subject: endpoint.id,
          // The destination, never the secret. An event is durable and reaches
          // `audit`.
          url: endpoint.url,
          events: endpoint.events,
        },
      },
      provenance,
    );
  });

  return { endpoint, secret: minted.reveal };
}

/** Load an endpoint the subject owns, or refuse as though it were absent. */
export async function ownedBy(
  deps: WebhooksDeps,
  subject: Subject,
  id: string,
): Promise<Endpoint> {
  const found = await deps.endpoints.byId(endpointId(id));
  // **404, never 403** — a 403 confirms the id names a real endpoint and turns
  // guessing into enumeration of other people's integrations.
  if (found?.ownerId !== subjectId(subject)) throw noSuchEndpoint();
  return found;
}

export interface UpdateInput {
  readonly url?: string;
  readonly events?: readonly string[];
  readonly state?: 'enabled' | 'disabled';
}

export async function updateEndpoint(
  deps: WebhooksDeps,
  subject: Subject,
  id: string,
  input: UpdateInput,
  provenance: Provenance,
): Promise<Endpoint> {
  const endpoint = await ownedBy(deps, subject, id);
  const at = deps.clock.now();

  if (input.url !== undefined) endpoint.redirect(input.url, at);
  if (input.events !== undefined) endpoint.resubscribe(input.events, at);

  let toggled: 'enabled' | 'disabled' | undefined;
  if (input.state === 'disabled') {
    if (endpoint.disable(DisabledBecause.Owner, at).changed) {
      toggled = 'disabled';
    }
  }
  if (input.state === 'enabled' && endpoint.enable(at).changed) {
    toggled = 'enabled';
  }

  await deps.transactor.within(async (work) => {
    await work.endpoints.save(endpoint);
    if (toggled !== undefined) {
      await work.publish(
        {
          name:
            toggled === 'disabled'
              ? WebhookEvent.EndpointDisabled
              : WebhookEvent.EndpointEnabled,
          payload: { subject: endpoint.id, by: 'owner' },
        },
        provenance,
      );
    }
  });

  return endpoint;
}

export async function rotateSecret(
  deps: WebhooksDeps,
  subject: Subject,
  id: string,
  provenance: Provenance,
): Promise<Registered> {
  const endpoint = await ownedBy(deps, subject, id);
  const minted = await deps.secrets.mint();

  endpoint.rotateSecret(minted.fingerprint, deps.clock.now());

  await deps.transactor.within(async (work) => {
    await work.endpoints.save(endpoint);
    await work.publish(
      {
        name: WebhookEvent.SecretRotated,
        payload: { subject: endpoint.id },
      },
      provenance,
    );
  });

  return { endpoint, secret: minted.reveal };
}

export async function deleteEndpoint(
  deps: WebhooksDeps,
  subject: Subject,
  id: string,
  provenance: Provenance,
): Promise<void> {
  const endpoint = await ownedBy(deps, subject, id);

  await deps.transactor.within(async (work) => {
    // **The deliveries go with it, in the same commit.** Leaving them would
    // leave rows referencing an endpoint nothing can look up, and a queued job
    // that would then fail forever on a delivery whose destination is gone.
    await work.deliveries.removeForEndpoint(endpoint.id, work.writer);
    await work.endpoints.remove(endpoint.id, work.writer);
    await work.publish(
      { name: WebhookEvent.EndpointDeleted, payload: { subject: endpoint.id } },
      provenance,
    );
  });
}

export type { EndpointId };
