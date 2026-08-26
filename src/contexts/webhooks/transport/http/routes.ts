/**
 * `webhooks` on the shared registry. **`webhooks` transport.**
 *
 * `/v1/webhooks` is not in `CONFORMANCE.md` §3.5's table, and §3.5 is explicit
 * that **a route not in the table is unspecified, not forbidden**. So the shape
 * follows the table's rules rather than inventing new ones: `/v1/<resource>`,
 * no context prefix, snake_case on the wire, keyset pages, `If-Match` on the
 * writes that can lose an update.
 *
 * **The secret appears in exactly two responses** — the registration and a
 * rotation — and never in a read. That is the difference between a store that
 * holds fingerprints and one that holds secrets: with the latter, every `GET`
 * is another chance to leak them.
 *
 * See `notes/domain/webhooks.md`.
 */

import { z } from 'zod';
import { type Subject } from '../../../../shared/authz/index.js';
import { type Exchange, json } from '../../../../shared/edge/index.js';
import { internal, unauthenticated } from '../../../../shared/errors/index.js';
import {
  type AnyRoute,
  routesFor,
} from '../../../../shared/httproute/index.js';
import { type Cursor } from '../../../../shared/pagination/index.js';
import {
  Carrier,
  type Provenance,
} from '../../../../shared/provenance/index.js';
import { type WebhooksDeps } from '../../app/ports.js';
import {
  deleteEndpoint,
  registerEndpoint,
  rotateSecret,
  updateEndpoint,
} from '../../app/command/endpoints.js';
import {
  listDeliveries,
  listEndpoints,
  readEndpoint,
  replayDelivery,
} from '../../app/query/read.js';
import { DELIVER } from '../../app/subscriber/fanout.js';
import { deliveryView, endpointView } from './views.js';

const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
});

const EndpointReply = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(z.string()),
  state: z.enum(['enabled', 'disabled']),
  disabled_because: z.string().optional(),
  consecutive_failures: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number(),
});

/** Registration and rotation only. **Shown once; never readable again.** */
const SecretReply = EndpointReply.extend({ secret: z.string() });

const DeliveryReply = z.object({
  id: z.string(),
  endpoint_id: z.string(),
  event_id: z.string(),
  event: z.string(),
  state: z.enum(['pending', 'succeeded', 'exhausted']),
  attempts: z.array(
    z.object({
      at: z.string(),
      status: z.number().optional(),
      error: z.string().optional(),
      took_ms: z.number(),
    }),
  ),
  total_attempts: z.number(),
  next_attempt_at: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    cursor: z.object({ next: z.string().optional() }),
  });

const RegisterBody = z
  .object({
    url: z.string(),
    events: z.array(z.string()),
  })
  .strict();

const UpdateBody = z
  .object({
    url: z.string().optional(),
    events: z.array(z.string()).optional(),
    state: z.enum(['enabled', 'disabled']).optional(),
  })
  .strict();

const route = routesFor<Subject>();

export type WebhookRoute = AnyRoute<Subject>;

export interface WebhookRoutesOptions {
  readonly deps: WebhooksDeps;
  readonly caller: (exchange: Exchange) => Subject | undefined;
}

function must(caller: Subject | undefined): Subject {
  if (caller === undefined) {
    throw unauthenticated('this request requires authentication');
  }
  return caller;
}

function provenance(): Provenance {
  const current = Carrier.current();
  if (current === undefined) {
    throw internal('webhooks routes must be mounted behind the httpx chain');
  }
  return current;
}

function limitOf(raw: string | undefined): number {
  const asked = raw === undefined ? 20 : Number(raw);
  if (!Number.isInteger(asked) || asked < 1) return 20;
  return Math.min(asked, 100);
}

const AUTHED = { 401: Problem, 403: Problem, 429: Problem } as const;
const MUTATING = { ...AUTHED, 409: Problem, 422: Problem } as const;

export function webhookRoutes(
  options: WebhookRoutesOptions,
): readonly WebhookRoute[] {
  const { deps } = options;

  return [
    route({
      method: 'POST',
      path: '/v1/webhooks',
      summary: 'Register a webhook endpoint',
      body: RegisterBody,
      // **201 carries the secret**, which is why it is not `EndpointReply`.
      replies: { 201: SecretReply, 400: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, body }) {
        const registered = await registerEndpoint(
          deps,
          must(caller),
          { url: body.url, events: body.events },
          provenance(),
        );

        return json(201, {
          ...endpointView(registered.endpoint),
          secret: registered.secret,
        });
      },
    }),

    route({
      method: 'GET',
      path: '/v1/webhooks',
      summary: 'List the caller`s webhook endpoints',
      replies: { 200: pageOf(EndpointReply), 400: Problem, ...AUTHED },
      auth: 'required',
      async handle({ caller, query }) {
        const page = await listEndpoints(deps, must(caller), {
          limit: limitOf(query['limit']),
          ...(query['cursor'] === undefined
            ? {}
            : { cursor: query['cursor'] as Cursor }),
        });

        return json(200, {
          // `items` is an array, never null — conformance case 32.
          items: page.items.map(endpointView),
          cursor: { ...(page.next === undefined ? {} : { next: page.next }) },
        });
      },
    }),

    route({
      method: 'GET',
      path: '/v1/webhooks/:id',
      summary: 'One webhook endpoint',
      // **304 and 412 because `validated` is true**, and S11 is what said so:
      // position 9 answers a conditional GET before this handler runs, and a
      // route that does not declare what its own chain produces publishes a
      // contract missing two statuses a caching client will absolutely see.
      replies: {
        200: EndpointReply,
        304: z.null(),
        404: Problem,
        412: Problem,
        ...AUTHED,
      },
      auth: 'required',
      validated: true,
      async handle({ caller, params }) {
        const endpoint = await readEndpoint(
          deps,
          must(caller),
          params['id'] ?? '',
        );
        return json(200, endpointView(endpoint));
      },
    }),

    route({
      method: 'PATCH',
      path: '/v1/webhooks/:id',
      summary: 'Update a webhook endpoint',
      body: UpdateBody,
      // **`If-Match` is not required here**, and that is deliberate rather than
      // an oversight. `identity`'s user routes demand one because a lost update
      // there silently changes who somebody is; an endpoint's fields are the
      // owner's own and a last-write-wins on your own integration is a shrug.
      // Position 9 still *honours* an `If-Match` when one is sent, so a careful
      // client gets the guarantee without every client being made to care.
      replies: {
        200: EndpointReply,
        400: Problem,
        404: Problem,
        412: Problem,
        ...MUTATING,
      },
      auth: 'required',
      validated: true,
      async handle({ caller, params, body }) {
        const endpoint = await updateEndpoint(
          deps,
          must(caller),
          params['id'] ?? '',
          {
            ...(body.url === undefined ? {} : { url: body.url }),
            ...(body.events === undefined ? {} : { events: body.events }),
            ...(body.state === undefined ? {} : { state: body.state }),
          },
          provenance(),
        );
        return json(200, endpointView(endpoint));
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/webhooks/:id',
      summary: 'Delete a webhook endpoint',
      replies: { 204: z.null(), 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        await deleteEndpoint(
          deps,
          must(caller),
          params['id'] ?? '',
          provenance(),
        );
        return json(204, null);
      },
    }),

    route({
      method: 'POST',
      path: '/v1/webhooks/:id/secret',
      summary: 'Rotate a webhook signing secret',
      replies: { 200: SecretReply, 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        const rotated = await rotateSecret(
          deps,
          must(caller),
          params['id'] ?? '',
          provenance(),
        );
        return json(200, {
          ...endpointView(rotated.endpoint),
          secret: rotated.secret,
        });
      },
    }),

    route({
      method: 'GET',
      path: '/v1/webhooks/:id/deliveries',
      summary: 'The delivery log for one endpoint',
      replies: {
        200: pageOf(DeliveryReply),
        400: Problem,
        404: Problem,
        ...AUTHED,
      },
      auth: 'required',
      async handle({ caller, params, query }) {
        const page = await listDeliveries(
          deps,
          must(caller),
          params['id'] ?? '',
          {
            limit: limitOf(query['limit']),
            ...(query['cursor'] === undefined
              ? {}
              : { cursor: query['cursor'] as Cursor }),
          },
        );

        return json(200, {
          items: page.items.map(deliveryView),
          cursor: { ...(page.next === undefined ? {} : { next: page.next }) },
        });
      },
    }),

    route({
      method: 'POST',
      path: '/v1/deliveries/:id/replay',
      summary: 'Send an exhausted delivery again',
      // **202, not 200.** The replay enqueues; it does not deliver. Answering
      // 200 would tell a caller the webhook had been sent, which is the one
      // thing this response cannot know.
      replies: { 202: DeliveryReply, 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        const delivery = await replayDelivery(
          deps,
          must(caller),
          params['id'] ?? '',
          provenance(),
          DELIVER,
        );
        return json(202, deliveryView(delivery));
      },
    }),
  ];
}
