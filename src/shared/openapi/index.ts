/**
 * The OpenAPI document, **generated from the registry**. L4 edge.
 *
 * `../../../MODULES.md`: *a spec generated from the schemas handlers use,
 * committed, diffed.* Three parts, and only the first is the easy one.
 *
 * **Generated.** This walks `httproute`'s route values and touches no handler.
 * A route already carries its method, its path, its body schema, its declared
 * responses and whether it needs a credential — everything a document needs is
 * a property of a value that already exists. **If a handler had to be annotated
 * to make this work, the registry would be missing something and that would be
 * the bug**, so nothing here reads one.
 *
 * **Committed.** `tools/openapi.ts` writes `docs/openapi.json`. A spec that
 * exists only at runtime cannot be reviewed, diffed or handed to anybody, which
 * is most of what a spec is for.
 *
 * **Diffed.** `make ci` regenerates and fails when the committed file differs.
 * That is the whole point: a schema change that alters the published contract
 * fails the build instead of shipping quietly. Without it this is decoration.
 *
 * **It inherits `S11`.** Every route declares the statuses it can answer and a
 * rule test proves the declaration covers what the chain can produce — so this
 * document is more honest than most hand-written ones, and anywhere it is wrong
 * is a real gap in a declaration rather than a documentation lapse.
 *
 * See `notes/patterns/openapi.md`.
 */

import { z } from 'zod';
import { type Declared, GLOBAL_STATUSES } from '../httproute/index.js';

/** What a document says about itself. Supplied by the root, not guessed. */
export interface Info {
  readonly title: string;
  readonly version: string;
  readonly description?: string;
}

/**
 * A route, as this module needs it.
 *
 * Structurally typed on `Declared` plus the two fields a document wants that a
 * status check does not — the same reason `statuses.ts` is structural: this
 * module must not drag a handler type into a document generator.
 */
export interface Documented extends Declared {
  readonly summary: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

type Json = Record<string, unknown>;

/**
 * `:id` becomes `{id}`.
 *
 * The registry spells a parameter the way a router matches it; OpenAPI spells
 * it the way a template does. Converting here rather than storing both is what
 * keeps one spelling authoritative — two would drift, and the one that drifted
 * would be the published one.
 */
function templated(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function parametersOf(path: string): readonly Json[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}

/**
 * A zod schema as JSON Schema.
 *
 * zod 4 does this itself, so there is no converter dependency to keep in step
 * with the validator — which matters more than the saved install: a converter
 * that lags the validator publishes a contract the server does not enforce.
 *
 * `io: 'output'` for a response and the default for a request, because the two
 * differ wherever a schema has a default or a transform: what a caller may send
 * and what it will receive are not the same document.
 */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  return z.toJSONSchema(schema, {
    io,
    // The document is one file, so a `$ref` to a shared section would be a
    // second thing to assemble. Inline is bigger and reviewable.
    target: 'draft-2020-12',
  });
}

const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Statuses that carry a problem document rather than a resource. */
const isProblem = (status: number): boolean => status >= 400;

function responsesOf(route: Documented): Json {
  const responses: Json = {};

  for (const [status, schema] of Object.entries(route.replies)) {
    const code = Number(status);
    const body = jsonSchema(schema as z.ZodType, 'output');

    // A `z.null()` reply is a route that answers with no body — 204, 202, 304.
    // An empty content map is how OpenAPI spells that, and it is not the same
    // as a body whose schema happens to permit null.
    const empty = body['type'] === 'null';

    responses[status] = {
      description: describe(code),
      ...(empty
        ? {}
        : {
            content: {
              [isProblem(code) ? PROBLEM_CONTENT_TYPE : 'application/json']: {
                schema: body,
              },
            },
          }),
    };
  }

  return responses;
}

/**
 * The two statuses every route shares, documented once per route.
 *
 * `ENFORCEMENT.md` S11 exempts them from the per-route declaration because
 * repeating them everywhere makes the declaration unreadable. A **document** is
 * read by a client rather than by a person maintaining routes, and a client
 * that has not been told about 500 is a client that treats one as a protocol
 * error. So they are added here — the exemption is about where the truth is
 * written, not about whether it is published.
 */
function globalResponses(): Json {
  const problem = {
    content: {
      [PROBLEM_CONTENT_TYPE]: {
        schema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'integer' },
            detail: { type: 'string' },
            instance: { type: 'string' },
          },
          required: ['type', 'title', 'status', 'detail'],
        },
      },
    },
  };

  return Object.fromEntries(
    GLOBAL_STATUSES.map((status) => [
      String(status),
      { description: describe(status), ...problem },
    ]),
  );
}

const TITLES: Readonly<Record<number, string>> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  304: 'Not Modified',
  400: 'Invalid request',
  401: 'Authentication required',
  403: 'Not permitted',
  404: 'Not found',
  409: 'Conflict',
  412: 'Precondition failed',
  422: 'Unprocessable',
  428: 'Precondition required',
  429: 'Too many requests',
  500: 'Internal error',
  503: 'Unavailable',
};

function describe(status: number): string {
  return TITLES[status] ?? `Status ${String(status)}`;
}

/**
 * Build the document.
 *
 * Deterministic: routes are sorted by path then method, and every object is
 * built in a fixed key order. **A generator whose output depends on the order
 * routes happen to be registered in cannot be diffed**, and a spec that cannot
 * be diffed is the one part of the three this module would fail.
 */
export function generate(routes: readonly Documented[], info: Info): Json {
  const paths: Json = {};

  const sorted = [...routes].sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );

  for (const route of sorted) {
    const path = templated(route.path);
    const existing = (paths[path] ?? {}) as Json;
    const parameters = parametersOf(route.path);

    existing[route.method.toLowerCase()] = {
      summary: route.summary,
      operationId: operationId(route),
      ...(parameters.length === 0 ? {} : { parameters }),
      ...(route.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: jsonSchema(route.body as z.ZodType, 'input'),
                },
              },
            },
          }),
      responses: { ...responsesOf(route), ...globalResponses() },
      // **Declared per route, not inferred.** An empty array is OpenAPI's
      // spelling of *no credential required*, and it is different from omitting
      // the key, which means *inherit the document default*.
      security: route.auth === 'required' ? [{ bearer: [] }] : [],
    };

    paths[path] = existing;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined
        ? {}
        : { description: info.description }),
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}

/**
 * A stable name for an operation.
 *
 * Derived from the method and path rather than taken from a field somebody
 * maintains: a hand-written `operationId` is a second name for a route, and the
 * second name is the one that goes stale. Client generators key on this, so it
 * has to be stable across runs — which is why it is a function of the route
 * rather than of its position.
 */
function operationId(route: Documented): string {
  const parts = templated(route.path)
    .split('/')
    .filter((segment) => segment !== '' && segment !== 'v1')
    .map((segment) =>
      segment.startsWith('{') ? `by-${segment.slice(1, -1)}` : segment,
    );

  return [route.method.toLowerCase(), ...parts]
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * The committed document, as bytes.
 *
 * Two spaces and a trailing newline, because the file is diffed by `make ci`
 * and by whoever reviews it — and a formatting difference that is not a
 * contract difference wastes both.
 */
export function render(document: Json): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
