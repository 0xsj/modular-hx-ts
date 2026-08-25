/**
 * `audit`'s HTTP surface. **One route, on the shared registry.**
 *
 * This file used to carry its own dispatcher — **the second copy of the
 * route-registration shape** — on the reasoning that `S6` made identity's
 * unreachable and `CONTEXTS.md` §8's *after the third context, this is
 * `scaffold`'s job* licensed copying until then.
 *
 * **That was wrong.** `scaffold` generates a context skeleton; it does not keep
 * copies agreeing afterwards, and a generator emitting the same registry into
 * seven contexts produces seven registries that diverge immediately. The
 * trigger for promotion is the **second copy**, not the third context — and
 * `S6` cuts one way: *therefore it belongs in the shared layer*. The registry
 * is now `shared/httproute` and both contexts use it.
 *
 * **`audit` does no authentication.** §3: the composition root lends it
 * identity's bearer auth and hands the caller over as an authz `Subject`. It
 * supplies a `caller` function and never sees a token — which is what keeps
 * `S6` true while still requiring an authenticated principal, and the reason
 * the shared registry must not carry authentication itself.
 *
 * See `notes/domain/audit.md`.
 */

import { z } from 'zod';
import { type Subject } from '../../../../shared/authz/index.js';
import { type Exchange, json } from '../../../../shared/edge/index.js';
import { invalid, unauthenticated } from '../../../../shared/errors/index.js';
import {
  type AnyRoute,
  router,
  routesFor,
} from '../../../../shared/httproute/index.js';
import { type AuditQuery } from '../../domain/index.js';
import { type SearchDeps, searchRecords } from '../../app/query/search.js';

/**
 * The query string, declared once.
 *
 * Everything is optional and everything is a string, because a query string is
 * strings — the coercions are here rather than in the handler so `openapi` can
 * describe them and the handler never parses.
 */
const SearchQuery = z.object({
  actor: z.string().optional(),
  subject: z.string().optional(),
  event: z.string().optional(),
  prefix: z.string().optional(),
  correlation: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().optional(),
});

const RecordReply = z.object({
  id: z.string(),
  eventId: z.string(),
  event: z.string(),
  actor: z.string(),
  subject: z.string().optional(),
  requestId: z.string(),
  correlationId: z.string(),
  causationId: z.string().optional(),
  tenant: z.string().optional(),
  occurredAt: z.string(),
  recordedAt: z.string(),
});

const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
});

/** Bound once, so every route below infers its body from its own schema. */
const route = routesFor<Subject>();

export type AuditRoute = AnyRoute<Subject>;

/** An ISO-8601 instant, or a refusal that names the field. */
function instant(raw: string | undefined, field: string): Date | undefined {
  if (raw === undefined) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(`not a timestamp: ${raw}`, [
      { field, message: 'is not an ISO-8601 timestamp' },
    ]);
  }
  return parsed;
}

export interface AuditRoutesOptions extends SearchDeps {
  /**
   * The caller, as an authz `Subject`.
   *
   * Supplied by the composition root from identity's authenticated caller —
   * §3. `audit` never resolves a token, which is what lets it read a caller's
   * identity without importing the context that owns one.
   */
  readonly caller: (exchange: Exchange) => Subject | undefined;
  /** Told when a route answers a status it never declared — S11. */
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
}

export function auditRoutes(
  options: AuditRoutesOptions,
): readonly AuditRoute[] {
  return [
    route({
      method: 'GET',
      path: '/v1/audit',
      summary: 'Search the audit log',
      replies: {
        200: z.array(RecordReply),
        400: Problem,
        401: Problem,
        403: Problem,
        // **Declared because the chain can produce it** — S11. Position 7
        // answers before this route is reached and under its name; a contract
        // that omitted it would be a published lie in the direction a client
        // trusts. `500` and `503` are the two globals and are not repeated.
        429: Problem,
      },
      // Every record read is somebody's, so there is no anonymous form of this.
      auth: 'required',
      async handle({ exchange, caller }) {
        const subject = must(caller);
        const parsed = SearchQuery.safeParse(exchange.request.query);
        if (!parsed.success) {
          throw invalid(
            'the query cannot be accepted',
            parsed.error.issues.map((issue) => ({
              field: issue.path.map(String).join('.') || '(query)',
              message: issue.message,
            })),
          );
        }

        const raw = parsed.data;
        // Parsed once each: calling `instant` twice per field would refuse a
        // bad timestamp twice and compute a good one twice.
        const since = instant(raw.since, 'since');
        const until = instant(raw.until, 'until');

        const query: AuditQuery = {
          ...(raw.actor === undefined ? {} : { actor: raw.actor }),
          ...(raw.subject === undefined ? {} : { subject: raw.subject }),
          ...(raw.event === undefined ? {} : { event: raw.event }),
          ...(raw.prefix === undefined ? {} : { prefix: raw.prefix }),
          ...(raw.correlation === undefined
            ? {}
            : { correlationId: raw.correlation }),
          ...(since === undefined ? {} : { since }),
          ...(until === undefined ? {} : { until }),
          ...(raw.limit === undefined ? {} : { limit: raw.limit }),
        };

        const found = await searchRecords(options, subject, query);

        return json(
          200,
          found.map((record) => {
            const { state } = record;
            return {
              id: state.id,
              eventId: state.eventId,
              event: state.event,
              actor: state.actor,
              ...(state.subject === undefined
                ? {}
                : { subject: state.subject }),
              requestId: state.requestId,
              correlationId: state.correlationId,
              ...(state.causationId === undefined
                ? {}
                : { causationId: state.causationId }),
              ...(state.tenant === undefined ? {} : { tenant: state.tenant }),
              occurredAt: state.occurredAt.toISOString(),
              recordedAt: state.recordedAt.toISOString(),
            };
          }),
        );
      },
    }),
  ];
}

/**
 * Present because the route declared `auth: 'required'`.
 *
 * The registry already refused an anonymous caller, so this is unreachable —
 * and it is a guard rather than a `!` because the day it *is* reachable is the
 * day somebody adds a route and writes `anonymous` by mistake.
 */
function must(caller: Subject | undefined): Subject {
  if (caller === undefined) {
    throw unauthenticated('this request requires authentication');
  }
  return caller;
}

export function auditRouter(options: AuditRoutesOptions) {
  return router<Subject>({
    routes: auditRoutes(options),
    caller: options.caller,
    ...(options.onUndeclared === undefined
      ? {}
      : { onUndeclared: options.onUndeclared }),
  });
}
