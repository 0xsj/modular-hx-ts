/**
 * **S11 — a route answers only what it declares.**
 *
 * `../../../ENFORCEMENT.md` S11. The declared response set is not documentation:
 * `openapi` publishes it **as the contract**, so a status a route can produce
 * and did not declare is not a missing annotation — it is a published contract
 * that lies, in the direction clients trust.
 *
 * This computes what the *chain* can answer for a given route, which is the
 * half a reader gets wrong. A handler's own statuses are visible in the handler;
 * the 400 from schema validation, the 401 from the registry, the 429 from
 * position 7 and the 412 from position 9 all come from code the route never
 * mentions, and every one of them reaches the client under that route's name.
 *
 * **When this fires, declare the status.** A 400 from schema validation is
 * correct behaviour; the route simply never said so.
 */

/**
 * What this needs to know about a route, and no more.
 *
 * Structural rather than `AnyRoute`, because the router imports *this* for the
 * global list and importing `AnyRoute` back would make the pair circular — the
 * cruiser's `no-circular` caught it on the first run. The narrower type is also
 * the honest one: nothing here has any business with a handler.
 */
export interface Declared {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly auth: 'required' | 'anonymous';
  readonly validated?: boolean;
  readonly replies: Readonly<Record<number, unknown>>;
}

/**
 * Statuses no route can avoid and every route shares.
 *
 * `500` is the recover position: any handler can throw something nobody
 * classified. `503` is readiness failing, and the store-unreachable refusals
 * that fail closed. Declaring these on every route is noise — `ENFORCEMENT.md`
 * S11 declares them once, here.
 */
export const GLOBAL_STATUSES: readonly number[] = [500, 503];

/** Methods with no state to protect — positions 9 skip them. */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/**
 * Which chain positions are mounted, and where they do not engage.
 *
 * Taken as an argument rather than assumed, because the answer is the
 * composition root's: a process that mounts no rate limiter cannot answer 429,
 * and asserting it could would push every route to declare a status it never
 * returns.
 */
export interface ChainShape {
  readonly ratelimit: boolean;
  readonly idempotency: boolean;
  readonly conditional: boolean;
  /** Paths positions 7 and 9 do not engage on. */
  readonly exempt: readonly string[];
  /**
   * The table refuses a credential *kind* on routes that did not opt in —
   * `identity`'s API-key guard. A 403 from a guard is the registry's, not the
   * handler's, so the route cannot see it to declare it.
   */
  readonly guarded: boolean;
}

/** Everything the chain and the registry can answer for one route. */
export function chainStatuses(
  route: Declared,
  chain: ChainShape,
): readonly number[] {
  const found = new Set<number>();
  const exempt = chain.exempt.includes(route.path);
  const safe = SAFE.has(route.method.toUpperCase());

  // The registry itself.
  if (route.body !== undefined) found.add(400); // schema validation, case 2
  if (route.auth === 'required') found.add(401);
  if (chain.guarded && route.auth === 'required') found.add(403);

  // Position 7. Never on an exempt path — throttling the endpoint an
  // orchestrator polls turns a traffic spike into a rolling restart.
  if (chain.ratelimit && !exempt) found.add(429);

  // Position 9, idempotency. Only a mutating method with a key gets this far,
  // and `503` is already global.
  if (chain.idempotency && !exempt && !safe) {
    found.add(409); // a claim still in flight
    found.add(422); // the key was used with a different request, or is spent
  }

  // Position 9, conditional. `304` only where there is a representation to
  // compare, which is what `validated` declares.
  if (chain.conditional && route.validated === true) {
    if (safe) found.add(304);
    found.add(412);
  }

  return [...found].sort((a, b) => a - b);
}

export interface Undeclared {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly from: string;
}

/** Every status the chain can produce that a route does not declare. */
export function undeclaredStatuses(
  routes: readonly Declared[],
  chain: ChainShape,
): readonly Undeclared[] {
  const global = new Set(GLOBAL_STATUSES);

  return routes.flatMap((route) => {
    const declared = new Set(
      Object.keys(route.replies).map((status) => Number(status)),
    );

    return chainStatuses(route, chain)
      .filter((status) => !declared.has(status) && !global.has(status))
      .map((status) => ({
        method: route.method,
        path: route.path,
        status,
        from: originOf(status),
      }));
  });
}

/** Where a status comes from, so a failure names the position to look at. */
function originOf(status: number): string {
  switch (status) {
    case 304:
      return 'conditional (position 9)';
    case 400:
      return 'schema validation';
    case 401:
      return 'the registry, for a route declaring auth: required';
    case 403:
      return 'the table guard, refusing a credential kind';
    case 409:
    case 422:
      return 'idempotency (position 9)';
    case 412:
      return 'conditional (position 9)';
    case 429:
      return 'ratelimit (position 7)';
    default:
      return 'the chain';
  }
}
