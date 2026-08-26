/**
 * `exports` on the shared registry. **`exports` transport.**
 *
 * Three routes the conformance suite has been waiting for — `POST /v1/exports`,
 * `GET` and `DELETE /v1/operations/{id}` — plus a download that is deliberately
 * a fourth.
 *
 * **The response is not the artifact.** A 202 returns a `Location`; the file is
 * served by a separate route with **its own authorization, checked at download
 * time**. A decision made when an export was created is a decision made before
 * the artifact existed and possibly hours before anybody reads it.
 *
 * See `notes/domain/exports.md`.
 */

import { z } from 'zod';
import { type Subject } from '../../../../shared/authz/index.js';
import { type Exchange, json, text } from '../../../../shared/edge/index.js';
import { internal, unauthenticated } from '../../../../shared/errors/index.js';
import {
  type AnyRoute,
  router,
  routesFor,
} from '../../../../shared/httproute/index.js';
import {
  Carrier,
  type Provenance,
} from '../../../../shared/provenance/index.js';
import { dataset, format } from '../../domain/index.js';
import { type ExportsDeps } from '../../app/ports.js';
import { requestExport } from '../../app/command/request.js';
import { cancelExport } from '../../app/command/cancel.js';
import { readForDownload, readOperation } from '../../app/query/read.js';
import { operationView } from './views.js';

const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
});

const OperationReply = z.object({
  id: z.string(),
  kind: z.string(),
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  result: z
    .object({
      href: z.string(),
      content_type: z.string().optional(),
      size: z.number().optional(),
    })
    .optional(),
  error: z.string().optional(),
  started_at: z.string(),
  finished_at: z.string().optional(),
});

/**
 * **`format` is the only required field**, and the conformance case sends only
 * that: `{"format": "csv"}`. A dataset defaults rather than being required,
 * because the case is about the *shape* of an async request and a blueprint
 * that demanded more would fail it for a reason unrelated to what it tests.
 */
const RequestBody = z
  .object({
    format: z.string(),
    dataset: z.string().optional(),
  })
  .strict();

const route = routesFor<Subject>();

export type ExportRoute = AnyRoute<Subject>;

export interface ExportRoutesOptions {
  readonly deps: ExportsDeps;
  readonly caller: (exchange: Exchange) => Subject | undefined;
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
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
    throw internal('exports routes must be mounted behind the httpx chain');
  }
  return current;
}

const AUTHED = { 401: Problem, 403: Problem, 429: Problem } as const;
const MUTATING = { ...AUTHED, 409: Problem, 422: Problem } as const;

export function exportRoutes(
  options: ExportRoutesOptions,
): readonly ExportRoute[] {
  const { deps } = options;

  return [
    route({
      method: 'POST',
      path: '/v1/exports',
      summary: 'Request an export',
      body: RequestBody,
      // **202 with a `Location`** — conformance case 45. The body carries the
      // id and `state: running`, so a client has something to render before it
      // polls.
      replies: { 202: OperationReply, 400: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, body }) {
        const accepted = await requestExport(
          deps,
          must(caller),
          {
            dataset: dataset(body.dataset ?? 'users'),
            format: format(body.format),
          },
          provenance(),
        );

        const started = await readOperation(
          deps,
          must(caller),
          accepted.operationId,
        );

        return json(202, operationView(started), {
          location: accepted.location,
        });
      },
    }),

    route({
      method: 'GET',
      path: '/v1/operations/:id',
      summary: 'Poll a long-running operation',
      // **A terminal state is reported exactly once** — case 46 — and that is a
      // property of the record rather than of this route: `operations` refuses
      // to move one, so two polls of a settled operation are byte-identical.
      replies: { 200: OperationReply, 404: Problem, ...AUTHED },
      auth: 'required',
      async handle({ caller, params }) {
        const found = await readOperation(
          deps,
          must(caller),
          params['id'] ?? '',
        );
        return json(200, operationView(found));
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/operations/:id',
      summary: 'Cancel a long-running operation',
      replies: { 204: z.null(), 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        await cancelExport(
          deps,
          must(caller),
          params['id'] ?? '',
          provenance(),
        );
        return text(204, '');
      },
    }),

    route({
      method: 'GET',
      path: '/v1/exports/:id/download',
      summary: 'Download a finished export',
      // **A separate route, with its own authorization.** Ownership, existence
      // and expiry are all asked *now* rather than when the export was created.
      // An expired artifact is 404 rather than 410: the difference between
      // *gone* and *never yours* is not the caller's to learn from a status.
      replies: { 200: z.string(), 404: Problem, ...AUTHED },
      auth: 'required',
      async handle({ caller, params }) {
        const row = await readForDownload(
          deps,
          must(caller),
          params['id'] ?? '',
        );

        const key = row.blobKey;
        if (key === undefined) throw internal('a servable export has a key');

        const found = await deps.blobs.get(
          key as Parameters<typeof deps.blobs.get>[0],
        );
        // The row says servable and the store disagrees: a sweep that removed
        // the bytes and crashed before the row. The next sweep fixes it; the
        // caller is told the same thing an expired export says.
        if (found === undefined) throw internal('the artifact is not readable');

        const chunks: Buffer[] = [];
        for await (const chunk of found.body) {
          chunks.push(
            Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)),
          );
        }

        return {
          status: 200,
          headers: {
            'content-type': found.info.contentType,
            'content-disposition': `attachment; filename="${row.id}.${row.format}"`,
          },
          body: Buffer.concat(chunks).toString('utf8'),
        };
      },
    }),
  ];
}

export function exportRouter(options: ExportRoutesOptions) {
  return router<Subject>({
    routes: exportRoutes(options),
    caller: options.caller,
    ...(options.onUndeclared === undefined
      ? {}
      : { onUndeclared: options.onUndeclared }),
  });
}
