/**
 * The Fastify adapter. **L4 edge.**
 *
 * The second of two servers, and the reason the chain is framework-neutral.
 *
 * **Fastify owns what Fastify is good at — routing, schema, the socket — and
 * the chain owns the cross-cutting order.** That split is
 * `../../../ARCHITECTURE.md` Part III working as intended: wrapping Fastify to
 * look like `node:http` would be the failure, and so would re-implementing
 * routing to avoid using it.
 *
 * What does **not** vary between the two adapters: the module's name, the
 * order, the single mapping point, and the observable behaviour. Both run the
 * same `chain`, so the same request produces the same response through either.
 *
 * See `notes/patterns/httpx.md`.
 */

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { guardHeaders } from './guard.js';
import { type Exchange, type Request } from '../edge/index.js';
import { type Server, type ServerOptions, TIMEOUTS } from './server.js';

function requestFrom(raw: FastifyRequest): Request {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value)
      ? (value[value.length - 1] ?? '')
      : value;
  }

  return {
    method: raw.method,
    path: new URL(raw.url, 'http://placeholder').pathname,
    query: raw.query as Record<string, string>,
    headers,
    peer: raw.ip,
    // Fastify has already read and parsed the body by the time a handler runs,
    // which is one of the things it is for.
    body: () =>
      Promise.resolve(
        typeof raw.body === 'string'
          ? raw.body
          : JSON.stringify(raw.body ?? ''),
      ),
  };
}

export interface FastifyServer extends Server {
  /** For registering routes, plugins and schemas — Fastify's own strengths. */
  readonly app: FastifyInstance;
}

export function fastifyServer(options: ServerOptions): FastifyServer {
  const timeouts = options.timeouts ?? TIMEOUTS;

  const app = Fastify({
    // Values, not omissions — the same numbers the `node:http` adapter sets, so
    // a slowloris is refused identically whichever server is running.
    //
    // `connectionTimeout` is deliberately 0. It is a whole-socket inactivity
    // timer, so it would also disconnect a peer waiting on a handler that is
    // still working — which the `node:http` adapter does not do, and *the
    // observable behaviour must not vary*. The guard below covers the window
    // this one was reached for.
    connectionTimeout: 0,
    keepAliveTimeout: timeouts.idle,
    requestTimeout: timeouts.read,
    // `logger` and `provenance` own this; Fastify's would be a second log line
    // with a different field set, which conformance §4.13 exists to prevent.
    // `logger: false` also turns off Fastify's own request logging, so the
    // access log at position 2 is the only one.
    logger: false,
    // The chain sets it, on every response, from the minted provenance.
    requestIdHeader: false,
  });

  // The same guard the `node:http` adapter installs, on the same `http.Server`.
  guardHeaders(app.server, timeouts.readHeader);

  // Everything not matched by a registered route runs the chain. A context that
  // registers its own Fastify routes still passes through it, because the chain
  // is installed as a hook below.
  app.all('/*', async (raw, reply) => {
    const exchange = {
      request: requestFrom(raw),
      remaining: () => timeouts.read,
    } as unknown as Exchange;

    const response = await options.handler(exchange);
    await reply
      .status(response.status)
      .headers(response.headers)
      .send(response.body);
  });

  app.setErrorHandler((error, _raw, reply) => {
    // Only reachable if the chain itself threw, which position 3 exists to
    // prevent. Reported rather than rendered here — a second error body is
    // exactly what the single mapping point forbids.
    options.onError?.(error);
    return reply.status(500).send();
  });

  return {
    app,
    start: async () => {
      await app.listen({ host: options.host, port: options.port });
    },
    stop: () => app.close(),
    address() {
      const bound = app.server.address();
      if (bound === null || typeof bound === 'string') return undefined;
      return { host: bound.address, port: bound.port };
    },
  };
}
