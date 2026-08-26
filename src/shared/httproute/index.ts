/**
 * The route registry. **L4, above `edge`** — `../../../MODULES.md` §5.
 *
 * `CONTEXTS.md` §8 step 5: **register each route with its request and response
 * schemas, and validate from that declaration — one source, never two.** A
 * handler that parses its own body is a handler `openapi` cannot read, and the
 * fix then is not adding a module — it is restructuring how every handler
 * declares its input. So the schema is a *field on the route*, the dispatcher
 * validates from that field, and the generator later walks the same array and
 * touches no handler.
 *
 * **Shared, because `S6` makes it unreachable otherwise.** A context may not
 * import another, so the second context cannot reuse the first's registry. Two
 * readings follow and only one survives: *therefore it belongs in the shared
 * layer*, or *therefore we copy it*. Copying defeats what the registry is for —
 * `openapi` must walk **one** registry, and two maintained in different
 * contexts drift from the day the second is written.
 *
 * **This repository wrote the second copy before the rule landed**, in `audit`,
 * reasoning that §8's *after the third context, this is `scaffold`'s job*
 * licensed it. That was wrong, and why is worth keeping: `scaffold` generates a
 * context *skeleton*, and a generator emitting the same registry into seven
 * contexts produces seven registries that diverge immediately. **The trigger
 * for promotion is the second copy, not the third context.**
 *
 * Three things are deliberate:
 *
 * - **Framework neutrality.** Routes are values; mounting is a fold over them
 *   into an `edge` `Handler`. `httpx` deliberately does not own routing, and
 *   this does not reach for Fastify's router either — the same registry mounts
 *   behind either server.
 * - **`auth` is declared, not inferred.** A route says whether it admits an
 *   anonymous caller, and the dispatcher refuses rather than letting a handler
 *   forget. Same principle as `idempotency`'s startup guard: **a fact about a
 *   mount belongs where the mount is declared.**
 * - **It carries no authentication, and knows nothing about credentials.** A
 *   context supplies a resolver and gets back whatever that returns; the
 *   registry never sees a token. That is what lets `audit` receive an
 *   authenticated principal while never importing the context that owns one.
 *
 * **What promotion cost, and it is the useful part.** Identity's copy had
 * `apiKeys: 'allowed'` on a route and read `caller.apiKey` in the dispatcher —
 * one context's credential model, in what is now shared code. It moved out to a
 * per-context `guard`, which is a better shape anyway: the registry asks *is
 * anyone here*, and the context asks *is this the right kind of anyone*.
 *
 * See `notes/patterns/httproute.md`.
 */

import { type ZodType } from 'zod';
import { type Exchange, type Response } from '../edge/index.js';
import { invalid, notFound, unauthenticated } from '../errors/index.js';
/**
 * Whoever the chain authenticated.
 *
 * **Deliberately opaque.** The registry never resolves a token and never looks
 * inside this — a context supplies a resolver and receives whatever it returns.
 * Typing it as the identity context's `Caller` would put a context's type in
 * the shared layer and break `S5`.
 */
export type Caller = unknown;

/**
 * What a handler is given.
 *
 * `body` is already parsed and typed by the route's own schema, so a handler
 * never calls `request.body()` and never validates. `caller` is present exactly
 * when the route required authentication, which is what makes it non-optional
 * on the routes that need it.
 */
export interface Context<Body> {
  readonly exchange: Exchange;
  readonly body: Body;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
}

export interface AuthedContext<Body> extends Context<Body> {
  readonly caller: Caller;
}

export interface Route<Body = unknown, C = Caller> {
  readonly method: string;
  /** `/users/:id`. One placeholder syntax, matched by the dispatcher below. */
  readonly path: string;
  /** One line, and `openapi` will use it as the operation summary. */
  readonly summary: string;

  /**
   * The request body's schema. **The only place it is described.**
   *
   * `undefined` means the route takes no body — which is a declaration too,
   * and one `openapi` needs in order to say so.
   */
  readonly body?: ZodType<Body>;

  /**
   * Response schemas by status. Declared even though nothing validates
   * responses at runtime today.
   *
   * That is the point of §8 step 5 rather than an omission: a response shape
   * that lives only in a handler's return statement is a shape the published
   * contract cannot describe, and adding it later means reading every handler.
   * Declared now, it costs a line and `openapi` walks it.
   */
  readonly replies: Readonly<Record<number, ZodType>>;

  /** Whether an anonymous caller may reach it. Declared, never inferred. */
  readonly auth: 'required' | 'anonymous';

  /**
   * Anything the owning context wants to say about this mount.
   *
   * **The registry never reads it** — it hands the route to the context's
   * `guard`, which does. `identity` uses it for *may an API key reach this*
   * (conformance case 16); another context will use it for something else, and
   * neither belongs in shared code.
   *
   * Opt-in by convention: a guard reading an absent key should refuse, so a
   * route added next year is refused until somebody thinks about it.
   */
  readonly meta?: Readonly<Record<string, unknown>>;

  /**
   * Mutating routes accept `If-Match` and supply their validator to
   * `conditional` — §8 step 5. Declared per route because a GET has one and a
   * POST that creates a resource does not.
   */
  readonly validated?: boolean;

  readonly handle: (
    context: Context<Body> & { readonly caller?: C },
  ) => Promise<Response>;
}

/**
 * A route with its body type erased, for the registry.
 *
 * The registry is a heterogeneous list — every route has a different body — and
 * TypeScript has no existential type to say so. `defineRoute` is the one place
 * that erasure happens, so the schema and the handler are checked against each
 * other *at the definition* and the list below is uniform afterwards.
 */
export type AnyRoute<C = Caller> = Omit<
  Route<unknown, C>,
  'body' | 'handle'
> & {
  readonly body?: ZodType;
  readonly handle: (
    context: Context<unknown> & { readonly caller?: C },
  ) => Promise<Response>;
};

/** Author a route with a typed body; hand back one the registry can hold. */
export function defineRoute<Body>(route: Route<Body>): AnyRoute {
  return route as AnyRoute;
}

/**
 * A `defineRoute` bound to one context's caller type.
 *
 * TypeScript takes explicit type arguments all-or-none, so a single
 * `defineRoute<Body, C>` forces a context to spell out `Body` too — and
 * spelling out `Body` is exactly what the registry exists to avoid, since the
 * whole point is that the schema *is* the declaration. Binding `C` once at the
 * top of a transport file leaves `Body` inferred from the schema at every call.
 */
export function routesFor<C>(): <Body>(route: Route<Body, C>) => AnyRoute<C> {
  return (route) => route as unknown as AnyRoute<C>;
}

/** Convenience for the common shape: a JSON body out, one success status. */
export const reply = (
  status: number,
  schema: ZodType,
): Record<number, ZodType> => ({ [status]: schema });

// --- matching ---------------------------------------------------------------

interface Match<C> {
  readonly route: AnyRoute<C>;
  readonly params: Record<string, string>;
}

/**
 * `/users/:id` against `/users/01a0…`.
 *
 * Segment-wise rather than by regular expression, because a path pattern
 * compiled to a regex is a second syntax nobody can read back — and `openapi`
 * has to render these patterns, so they stay inspectable.
 */
function matches(
  pattern: string,
  path: string,
): Record<string, string> | undefined {
  const wanted = pattern.split('/').filter((s) => s.length > 0);
  const got = path.split('/').filter((s) => s.length > 0);
  if (wanted.length !== got.length) return undefined;

  const params: Record<string, string> = {};
  for (const [index, segment] of wanted.entries()) {
    const actual = got[index] ?? '';
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (segment !== actual) return undefined;
  }
  return params;
}

export interface RouterOptions<C = Caller> {
  /**
   * Told when a route answers a status it never declared. **S11's other half.**
   *
   * The rule test computes what the *chain* can produce and is exact about it;
   * what it cannot see is a handler returning a status nobody wrote down —
   * `202` from a branch, a `404` from a lookup, a `409` mapped from a
   * constraint. Only the running route knows that.
   *
   * It **reports and never changes the answer**. A guard that turned an
   * undeclared `404` into a `500` would break a correct response to enforce its
   * own bookkeeping, and the client would pay for the omission.
   */
  readonly onUndeclared?: (route: AnyRoute<C>, status: number) => void;
  readonly routes: readonly AnyRoute<C>[];
  /**
   * Who is calling, if anyone.
   *
   * **The registry does no authentication** — the chain's position 6 did, and
   * this reads the result. A context that needs a caller supplies this; a
   * context that does not passes a function returning `undefined` and declares
   * every route `anonymous`.
   */
  readonly caller: (exchange: Exchange) => C | undefined;

  /**
   * The context's own check on a resolved caller. Throws to refuse.
   *
   * **Where credential-kind rules live**, because the registry has no opinion
   * about kinds. `identity` refuses an API key on key management, logout and
   * password change here; the registry only knows whether *somebody* is there.
   */
  readonly guard?: (route: AnyRoute<C>, caller: C) => void;
}

/**
 * Fold the registry into one `edge` handler.
 *
 * Mounted behind `httpx`'s chain, so everything the chain guarantees still
 * holds: this returns responses and throws typed errors, and position 3 renders
 * every failure as one RFC 9457 body.
 */
/**
 * Does this table own the request? **The root's question, not a route's.**
 *
 * Needed the day two contexts stopped being separable by a path prefix, which
 * `CONFORMANCE.md` §3.5 made permanent: `identity` serves `/v1/users` and
 * `audit` serves `/v1/audit`, and a composition root folding on `/identity/`
 * was reading the architecture off the URL exactly as §3.5 forbids a client to.
 *
 * It answers on **path alone, ignoring the method**, so a table that has the
 * path but not the verb keeps the request and answers 405 itself. Handing it on
 * would turn a wrong method into a 404 from whatever table came last.
 */
export function owns<C>(
  routes: readonly AnyRoute<C>[],
): (method: string, path: string) => boolean {
  return (_method, path) =>
    routes.some((route) => matches(route.path, path) !== undefined);
}

export function router<C = Caller>(options: RouterOptions<C>) {
  return async (exchange: Exchange): Promise<Response> => {
    const { request } = exchange;

    const found = find(options.routes, request.method, request.path);
    if (found === undefined) {
      // A path that matches nothing is a 404. A path that matches with the
      // **wrong method is a 400** whose detail says so — not a 405, and this
      // comment used to claim 405 while the code returned 400.
      //
      // There is no `Kind` for 405: decision 0010 fixed the vocabulary at
      // eleven and *method not allowed* is not among them. The distinction is
      // still worth making and is made in the detail, which is what stops a
      // client debugging a typo it did not make — but the status is 400 and
      // saying otherwise in a comment is how the gap stayed invisible. Raised
      // for the collection rather than widened here.
      throw methodOrPath(options.routes, request.method, request.path);
    }

    // **Read, never resolved here.** Position 6 authenticated and set the
    // actor on the provenance; resolving a second time in the router is how
    // the actor and the caller drift apart.
    const caller = options.caller(exchange);

    // The context's own check on the kind of credential, if it has one. The
    // registry knows whether *somebody* is here; whether they are the right
    // kind of somebody is not shared knowledge.
    if (caller !== undefined) options.guard?.(found.route, caller);

    if (found.route.auth === 'required' && caller === undefined) {
      // Conformance case 8's second half, and the one refusal every failure
      // mode shares: absent, malformed, unknown, expired, revoked, or a user
      // since disabled.
      throw unauthenticated('this request requires authentication');
    }

    const body = await parseBody(found.route, exchange);

    const response = await found.route.handle({
      exchange,
      body,
      params: found.params,
      query: request.query,
      ...(caller === undefined ? {} : { caller }),
    });

    if (options.onUndeclared !== undefined) {
      const declared = new Set(
        Object.keys(found.route.replies).map((status) => Number(status)),
      );
      if (
        !declared.has(response.status) &&
        !GLOBAL_STATUSES.includes(response.status)
      ) {
        options.onUndeclared(found.route, response.status);
      }
    }

    return response;
  };
}

/**
 * The matching route. **Most specific wins, never first declared.**
 *
 * `orgs` found this the expensive way: `DELETE /v1/orgs/{id}/members/me` and
 * `DELETE /v1/orgs/{id}/members/{userId}` both match the same request, and a
 * first-match router answered with whichever was written higher in the file —
 * so *leave this organization* became *remove the member called `me`*, and the
 * symptom was a 404 that looked like a missing member rather than a routing
 * bug.
 *
 * Declaration order is the wrong tiebreak because it makes correctness depend
 * on the order somebody typed routes in, and nothing anywhere says so. Counting
 * literal segments is the standard rule and needs no discipline to hold: a
 * literal beats a parameter because it describes exactly one request, and a
 * parameter describes many.
 */
function find<C>(
  routes: readonly AnyRoute<C>[],
  method: string,
  path: string,
): Match<C> | undefined {
  let best: Match<C> | undefined;
  let bestScore = -1;

  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const params = matches(route.path, path);
    if (params === undefined) continue;

    const score = route.path
      .split('/')
      .filter((segment) => segment !== '' && !segment.startsWith(':')).length;
    if (score > bestScore) {
      best = { route, params };
      bestScore = score;
    }
  }
  return best;
}

function methodOrPath<C>(
  routes: readonly AnyRoute<C>[],
  method: string,
  path: string,
): Error {
  const pathExists = routes.some(
    (route) => matches(route.path, path) !== undefined,
  );
  return pathExists
    ? invalid(`${method} is not allowed on ${path}`)
    : notFound(`no route for ${path}`);
}

/**
 * Parse the body **from the route's own schema**.
 *
 * Every field problem at once, in an `errors` map keyed by field path —
 * conformance case 2. zod collects them all, which is why the boundary is where
 * validation belongs and the domain's constructors are the second line.
 */
async function parseBody(
  route: AnyRoute<never>,
  exchange: Exchange,
): Promise<unknown> {
  if (route.body === undefined) return undefined;

  const raw = await exchange.request.body();
  let parsed: unknown;
  try {
    parsed = raw === '' ? {} : JSON.parse(raw);
  } catch {
    throw invalid('the request body is not JSON');
  }

  const result = route.body.safeParse(parsed);
  if (result.success) return result.data;

  throw invalid(
    'the request cannot be accepted',
    result.error.issues.map((issue) => ({
      field: issue.path.map(String).join('.') || '(body)',
      message: issue.message,
    })),
  );
}

import { GLOBAL_STATUSES } from './statuses.js';

export {
  type ChainShape,
  type Declared,
  type Undeclared,
  GLOBAL_STATUSES,
  chainStatuses,
  undeclaredStatuses,
} from './statuses.js';
