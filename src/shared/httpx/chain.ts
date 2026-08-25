/**
 * The middleware chain. **L4 edge, and the order is the contract.**
 *
 * `../../../MODULES.md` §5 specifies it. Eight repositories each inventing a
 * plausible order produces eight different answers to *does a 429 carry a
 * request id*, and none of them surfaces until something downstream depends on
 * it.
 *
 * **Outermost → innermost:**
 *
 * | # | Position | Why it sits here |
 * | -- | --- | --- |
 * | 1 | provenance | Everything below needs a request id, including the log line and the error body |
 * | 2 | access log | Records the status that finally emerges, including one produced by a panic |
 * | 3 | problem mapper | `I7`'s *mapped to transport codes only in transport* is this line |
 * | 4 | recover | A panic becomes a typed internal error, rendered by 3 |
 * | 5 | **deadline** | *(slot)* Everything below runs inside the request budget |
 * | 6 | authn | Sets the actor. Never adopts one |
 * | 7 | **ratelimit** | *(slot)* Keyed on the principal from 6 |
 * | 8 | tenant | Sets the tenant; needs the actor from 6 |
 * | 9 | **idempotency** | *(slot)* Claims before the handler runs |
 * | 9 | **conditional** | *(slot)* Joins at 9, **inside** idempotency so a replay is not re-evaluated |
 * | 10 | the handler | |
 *
 * **Two positions are counterintuitive and are the ones worth stating twice.**
 *
 * **Recover sits *inside* the problem mapper.** The instinct is to put it
 * outermost, where it catches the most. But a panic caught above the mapper has
 * to render its own response, and then there are two places that build an error
 * body. Inside, a panic becomes a typed `internal` and is rendered by the same
 * code that renders a returned one — so **a panic and a returned error are
 * indistinguishable to the client**, which is the property being bought.
 *
 * **Ratelimit sits *after* authn, not before.** The instinct is the opposite:
 * reject cheap work early. But conformance case 40 requires **per-caller**
 * limits, and a limiter that runs first has no caller to key on — it can only
 * key on the peer address, which is one NAT away from being useless. The trade
 * is real: an auth check is spent on a caller who is about to be throttled.
 * **Correctness wins, and the cost is noted rather than the order reversed.**
 *
 * See `notes/patterns/httpx.md`.
 */

import {
  type Millis,
  type Clock,
  millis,
  seconds,
  since,
} from '../clock/index.js';
import { isAppError, Kind, kindOf, wrap } from '../errors/index.js';
import { Carrier, type Origins } from '../provenance/index.js';
import { type Telemetry } from '../telemetry/index.js';
import {
  type Exchange,
  type Handler,
  type Middleware,
  type Reporter,
} from '../edge/index.js';
import { PROBLEM_CONTENT_TYPE, problemFor, statusFor } from './problem.js';

/**
 * Verify credentials and set the actor, or leave the exchange anonymous.
 *
 * Throws to refuse. It never *adopts* an actor from a header —
 * `../../../PROVENANCE.md` §5 calls that an authentication bypass, and the
 * allowlist type makes it unwritable anyway.
 */
export type Authenticator = (exchange: Exchange) => Promise<void> | void;

/** Resolve and set the tenant. Throws `NotFound`/`Forbidden` to refuse. */
export type TenantResolver = (exchange: Exchange) => Promise<void> | void;

export interface ChainOptions {
  readonly clock: Clock;
  readonly origins: Origins;
  readonly telemetry: Telemetry;
  readonly reporter?: Reporter;
  /** The per-request budget position 5 will spend. */
  readonly budget?: Millis;

  readonly authenticate?: Authenticator;
  readonly resolveTenant?: TenantResolver;

  /**
   * The three slots, **named and empty**.
   *
   * `deadline`, `ratelimit` and `idempotency` are separate modules that do not
   * exist yet. They are declared here rather than described in a comment,
   * because a slot added after three modules have each chosen their own
   * insertion point is the expensive retrofit — the same reason `lifecycle`
   * gets its drain phase before `maintenance` needs it.
   */
  readonly deadline?: Middleware;
  readonly ratelimit?: Middleware;
  readonly idempotency?: Middleware;
  /**
   * Position 9 as well — `../../../MODULES.md` §5: *`conditional` joins at 9*.
   *
   * **Inside `idempotency`, not outside it.** A replay must return the stored
   * response bit for bit, and re-evaluating preconditions against state that
   * has moved since would turn a replay into a 412.
   */
  readonly conditional?: Middleware;
}

/** A slot nobody has filled: pass straight through. */
const passThrough: Middleware = (exchange, next) => next(exchange);

export function chain(options: ChainOptions, handler: Handler): Handler {
  const { clock, origins, telemetry } = options;
  const budget = options.budget ?? seconds(30);

  const order: readonly Middleware[] = [
    provenance(origins, clock, budget),
    accessLog(clock, telemetry, options.reporter),
    problemMapper(options.reporter),
    recover(),
    options.deadline ?? passThrough, // 5
    authn(options.authenticate),
    options.ratelimit ?? passThrough, // 7
    tenant(options.resolveTenant),
    options.idempotency ?? passThrough, // 9
    options.conditional ?? passThrough, // 9, inside idempotency
  ];

  // Folded right to left so the first entry is outermost.
  return order.reduceRight<Handler>(
    (next, middleware) => (exchange) => middleware(exchange, next),
    handler,
  );
}

// --- 1 · provenance --------------------------------------------------------

/**
 * Mint, then adopt. **This module is the one and only caller of adoption.**
 *
 * A malformed inbound value is dropped and the minted one kept; it never fails
 * the request, because **provenance grants nothing** and a broken trace link is
 * cheaper than a rejected request.
 */
function provenance(
  origins: Origins,
  clock: Clock,
  budget: Millis,
): Middleware {
  return async (exchange, next) => {
    const headers = exchange.request.headers;
    const startedAt = clock.elapsed();

    // The allowlist type carries only what §5 permits: no request id, no
    // actor, no tenant. The bypass is not something to remember — it is
    // something that cannot be written.
    const inbound = {
      ...(headers['x-correlation-id'] === undefined
        ? {}
        : { correlationId: headers['x-correlation-id'] }),
      ...(headers['x-causation-id'] === undefined
        ? {}
        : { causationId: headers['x-causation-id'] }),
      ...(headers['traceparent'] === undefined
        ? {}
        : { traceparent: headers['traceparent'] }),
    };

    const minted = origins.forRequest(inbound);

    const scoped: Exchange = {
      request: exchange.request,
      provenance: minted,
      // Empty, and filled by whichever position below needs a header to survive
      // its own throw. See `edge`.
      responseHeaders: {},
      remaining: () => millis(Math.max(0, budget - since(clock, startedAt))),
    };

    // Ambient from here down, so a log line written by code that never asked
    // for provenance still carries one.
    const response = await Carrier.run(scoped.provenance, () => next(scoped));

    // **Every response carries a request id** — a 500 from a panic and a 429
    // from the limiter included. That is what position 1 buys.
    //
    // `responseHeaders` first, so a response that sets the same header wins:
    // the exchange's are a floor for positions that could not reach the
    // response, not an override of the one that did.
    return {
      ...response,
      headers: {
        ...scoped.responseHeaders,
        ...response.headers,
        'x-request-id': scoped.provenance.requestId,
        'x-correlation-id': scoped.provenance.correlationId,
      },
    };
  };
}

// --- 2 · access log --------------------------------------------------------

/**
 * Records the status that finally emerges, not the one the handler intended.
 *
 * **Carries `err_kind`, not only the status.** Two different `Kind`s can produce
 * the same status — `invalid` and a 4xx from an upstream both render 400 — and
 * the status alone cannot tell you which. `../../../MODULES.md` §2 fixes the
 * field names; conformance §4.13 constrains them across blueprints.
 */
function accessLog(
  clock: Clock,
  telemetry: Telemetry,
  reporter?: Reporter,
): Middleware {
  return async (exchange, next) => {
    const startedAt = clock.elapsed();

    return telemetry.tracer.inSpan(
      `${exchange.request.method} ${exchange.request.path}`,
      async (span) => {
        const response = await next(exchange);
        const took = millis(Math.round(since(clock, startedAt)));

        span.setAttribute('http.status', response.status);
        const kind = response.headers['x-error-kind'];

        reporter?.info('request', {
          method: exchange.request.method,
          path: exchange.request.path,
          status: response.status,
          took_ms: took,
          ...(kind === undefined ? {} : { err_kind: kind }),
        });

        // Internal-only: it exists to get the Kind from the mapper to the log
        // line, and a client has no use for it.
        const { 'x-error-kind': _drop, ...headers } = response.headers;
        return { ...response, headers };
      },
    );
  };
}

// --- 3 · problem mapper ----------------------------------------------------

/**
 * The one place a typed error becomes RFC 9457.
 *
 * A handler that writes its own problem response is a bug the chain should make
 * impossible: everything below throws, and only this line renders.
 *
 * **It also reports what it hid.** A 500's `detail` is deliberately generic —
 * *The request could not be completed.* — because the cause may name a table, a
 * column or a constraint, and none of that is the client's. Which left the
 * cause nowhere at all: the access log carries `err_kind: internal` and the
 * body carries a sentence, and the `TypeError` that started it was discarded.
 *
 * That was found by asking a running process to register a user against a
 * database that was missing a table. Every unit test was green, and the only
 * evidence of the failure anywhere in the system was the number 500.
 */
function problemMapper(reporter?: Reporter): Middleware {
  return async (exchange, next) => {
    try {
      return await next(exchange);
    } catch (error) {
      // **A cancellation is recorded, never rendered.** Collection decision
      // 0010: 499 is for the log, not the wire — the caller has already gone,
      // so there is nobody to send a body to. Building one would spend work
      // serialising a document into a closed socket, and would put a
      // *response* in the access log where a truncated exchange belongs.
      //
      // This is the late-error situation reached by a different route, and the
      // same rule applies: the honest record is that the request stopped, not
      // that it was answered.
      if (kindOf(error) === Kind.Canceled) {
        return {
          status: statusFor(Kind.Canceled),
          headers: { 'x-error-kind': Kind.Canceled },
          body: '',
        };
      }

      const problem = problemFor(error, exchange.provenance.requestId);

      // **5xx only.** A 404 or a 401 is the system working, and reporting it at
      // `error` would train whoever reads the log to stop reading it. A 5xx is
      // the system failing, and its cause is the one thing nobody can recover
      // from anywhere else.
      if (problem.status >= 500) {
        reporter?.error('the request failed', {
          method: exchange.request.method,
          path: exchange.request.path,
          status: problem.status,
          err: error,
        });
      }

      return {
        status: problem.status,
        headers: {
          'content-type': PROBLEM_CONTENT_TYPE,
          // Read by position 2 and stripped there.
          'x-error-kind': problem.type.slice('/problems/'.length),
        },
        body: JSON.stringify(problem),
      };
    }
  };
}

// --- 4 · recover -----------------------------------------------------------

/**
 * A panic becomes a typed internal error, **inside** the mapper.
 *
 * What this catches is the throw nobody classified — a `TypeError`, a string, a
 * rejected promise carrying `undefined`. It wraps rather than renders, so
 * position 3 does the rendering and there is exactly one error body in the
 * process.
 *
 * **A typed error passes through untouched.** Wrapping one here would prefix a
 * deliberate `NotFound` with this position's narration, and that narration
 * reaches the client: `detail` on a 4xx is the message, verbatim. Context is
 * added where a layer boundary is crossed and something is known — `I7` — and
 * this position knows nothing but that something threw.
 */
function recover(): Middleware {
  return async (exchange, next) => {
    try {
      return await next(exchange);
    } catch (error) {
      if (isAppError(error)) throw error;
      // Not an `AppError`: `wrap` makes it `Internal` and keeps the cause, so
      // the log line still names the `TypeError` the client never sees.
      throw wrap(error, 'the request could not be handled');
    }
  };
}

// --- 6 · authn -------------------------------------------------------------

/** Sets the actor after credentials verify. Never adopts one. */
function authn(authenticate?: Authenticator): Middleware {
  return async (exchange, next) => {
    if (authenticate !== undefined) await authenticate(exchange);
    // The authenticator replaced the provenance; re-scope the carrier so
    // everything below — and every log line — sees the actor.
    return Carrier.run(exchange.provenance, () => next(exchange));
  };
}

// --- 8 · tenant ------------------------------------------------------------

/** Sets the tenant after the resolver runs. Needs the actor from 6. */
function tenant(resolve?: TenantResolver): Middleware {
  return async (exchange, next) => {
    if (resolve !== undefined) await resolve(exchange);
    return Carrier.run(exchange.provenance, () => next(exchange));
  };
}

/** The positions, in order, for a test that asserts the contract. */
export const POSITIONS: readonly string[] = [
  'provenance',
  'access-log',
  'problem-mapper',
  'recover',
  'deadline',
  'authn',
  'ratelimit',
  'tenant',
  'idempotency',
  'conditional',
  'handler',
];
