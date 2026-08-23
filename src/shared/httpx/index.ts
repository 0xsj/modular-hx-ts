/**
 * The HTTP edge. **L4, and the first of the layer.**
 *
 * **What this module owns:** the server port, safe timeouts, the middleware
 * chain written once, and RFC 9457 problem mapping. **Not** routing tables, not
 * handlers, not any context.
 *
 * **The order is the contract**, and it is `../../../MODULES.md` §5's rather
 * than this repository's:
 *
 * ```
 * provenance · access log · problem mapper · recover · [deadline] ·
 * authn · [ratelimit] · tenant · [idempotency] · [conditional] · handler
 * ```
 *
 * Bracketed positions are **named and empty** — `deadline`, `ratelimit` and
 * `idempotency` are separate modules that do not exist yet, and a slot added
 * after three modules have each chosen their own insertion point is the
 * expensive retrofit.
 *
 * **What the chain guarantees that no individual middleware does:** every
 * response carries a request id, every error body is built in exactly one
 * place, and a handler writing its own problem response is a bug the chain
 * makes impossible.
 *
 * Note: `notes/patterns/httpx.md`.
 */

export {
  type Authenticator,
  type ChainOptions,
  type TenantResolver,
  POSITIONS,
  chain,
} from './chain.js';

export {
  type Problem,
  PROBLEM_CONTENT_TYPE,
  problemFor,
  statusFor,
} from './problem.js';

export {
  type Server,
  type ServerOptions,
  type Timeouts,
  TIMEOUTS,
} from './server.js';

export { nodeServer } from './node.js';
export { type FastifyServer, fastifyServer } from './fastify.js';
