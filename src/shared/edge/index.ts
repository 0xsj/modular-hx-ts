/**
 * The chain vocabulary. **The floor of L4** — `../../../ARCHITECTURE.md` §L4,
 * which names this module.
 *
 * The handler and middleware types every L4 module needs in order to be written
 * at all. `httpx` **assembles** the chain; `idempotency`, `ratelimit` and
 * `conditional` are **positions in** it, and all four need these types.
 *
 * **Same shape as L0's vocabulary, one layer up, for the same reason.** A layer
 * whose members share a type needs somewhere below them to put it. Left inside
 * `httpx`, every other L4 module imports a peer — permitted by `S1` and flagged
 * in review, which turns a flag meant to catch something into one that fires on
 * every module in the layer and stops being read. In the floor, the dependency
 * points downward like every other.
 *
 * It carries the layer's own name because it is **the layer's vocabulary** —
 * the relationship `errors` has to L0.
 *
 * Framework-neutral on purpose, and the reason here is stronger than the
 * general one. Part III expects a framework to be used where it owns something
 * — routing, its own filter abstraction — and **this repository ships two
 * servers behind one port**, so the chain cannot be written against either
 * one's types. A middleware that only ever sees `Request` and `Response` cannot
 * accidentally couple itself to `node:http` or to Fastify.
 *
 * See `notes/patterns/edge.md`.
 */

import { type Millis } from '../clock/index.js';
import { type Provenance } from '../provenance/index.js';

/**
 * Where a middleware announces something an operator must see.
 *
 * Three methods, declared here rather than importing `logger`: interfaces
 * belong to the consumer, and every position in the chain is a consumer. It
 * lives in the floor because `idempotency` needs it to report a fail-closed
 * refusal (`I9` requires the choice to be *logged when it fires*) and `httpx`
 * needs it for the access line — two modules, one shape, neither owning it.
 */
export interface Reporter {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface Request {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** The peer address, for a limiter with no principal to key on. */
  readonly peer: string;
  body(): Promise<string>;
}

export interface Response {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * What the chain threads through itself.
 *
 * Mutable in exactly the places the order requires: position 1 sets provenance,
 * 6 sets the actor, 8 sets the tenant. Each is set **after** the step that
 * earns it, which is what makes the order a contract rather than a preference.
 */
export interface Exchange {
  readonly request: Request;
  provenance: Provenance;
  /**
   * Headers this exchange must carry **whatever the outcome**.
   *
   * A position below the problem mapper cannot put a header on an error
   * response: it throws, position 3 renders, and the code after its own `next`
   * never runs. `ratelimit` is the case that needs this — conformance 39 wants
   * `RateLimit-*` on the 429 *and* on the 200, and position 7 is below position
   * 3 precisely so its refusal goes through the same mapper as every other
   * error.
   *
   * The alternative designs are both worse. Rendering the 429 in position 7
   * gives the process a second place that builds an error body. Carrying the
   * headers on the error's `details` puts HTTP in an L0 vocabulary, which is
   * what collection decision 0010 rejected for status codes and rejects here
   * for the same reason.
   *
   * Merged by position 1, which already does exactly this for `x-request-id`.
   * A response that sets a header of its own wins: this is a floor, not an
   * override.
   */
  readonly responseHeaders: Record<string, string>;
  /**
   * What remains of the request's budget.
   *
   * **Nothing spends this yet.** `../../../RESILIENCE.md` §4: *leave the
   * request's remaining budget reachable from the context so `deadline` can
   * spend it later, rather than each downstream call inventing its own
   * timeout.* Position 5 becomes arithmetic over a value that already exists
   * rather than a new thing threaded through every handler.
   */
  remaining(): Millis;
}

/**
 * **The committed-tracking response writer is not here, and its absence is the
 * note rather than an oversight.**
 *
 * `MODULES.md` §5's late-error rule needs a writer that records whether it has
 * been written to, so an error after the response is committed can abort the
 * connection instead of sending a well-formed truncated body. That rule
 * presupposes streaming.
 *
 * `Response.body` is a `string`, so nothing behind this chain streams: a
 * response is complete before any position sees it, and there is no committed
 * state to track. The rule is therefore satisfied vacuously — and vacuously is
 * a real answer only while the premise holds. **When `httpx` grows a streaming
 * response, the writer belongs in this file**, and the rule stops being
 * structural and starts being code.
 */

export type Handler = (exchange: Exchange) => Promise<Response>;

/** Outer wraps inner. `next` is the rest of the chain. */
export type Middleware = (
  exchange: Exchange,
  next: Handler,
) => Promise<Response>;

/**
 * A JSON response, optionally with more headers.
 *
 * The third parameter arrived with the first `202`: a `Location` is part of the
 * answer rather than something to bolt on after, and a caller building the
 * object by hand to add one is a caller who has stopped using the helper — and
 * will eventually forget the content type.
 */
export const json = (
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(value),
});

export const text = (status: number, body: string): Response => ({
  status,
  headers: { 'content-type': 'text/plain; charset=utf-8' },
  body,
});
