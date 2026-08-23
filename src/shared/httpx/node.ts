/**
 * The `node:http` adapter. **L4 edge.**
 *
 * One of two servers this repository ships behind one port. Both run the same
 * `chain`; what differs is who owns the socket and the routing, which is the
 * variance `../../../ARCHITECTURE.md` Part III expects rather than forbids.
 *
 * See `notes/patterns/httpx.md`.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { internal } from '../errors/index.js';
import { guardHeaders } from './guard.js';
import { type Exchange, type Request } from '../edge/index.js';
import { type Server, type ServerOptions, TIMEOUTS } from './server.js';

/** Node gives header values as `string | string[]`; the chain wants one value. */
function headersOf(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    // The last wins, matching what a proxy chain means by a repeated header.
    out[name.toLowerCase()] = Array.isArray(value)
      ? (value[value.length - 1] ?? '')
      : value;
  }
  return out;
}

export function requestFrom(
  message: IncomingMessage,
  maxBodyBytes: number,
): Request {
  const url = new URL(message.url ?? '/', 'http://placeholder');

  return {
    method: message.method ?? 'GET',
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: headersOf(message),
    peer: message.socket.remoteAddress ?? 'unknown',

    body: () =>
      new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;

        message.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          // Bounded for the same reason `httpclient` bounds a response:
          // `Content-Length` is a claim, not a limit.
          if (size > maxBodyBytes) {
            message.destroy();
            reject(internal('request body exceeded the limit'));
            return;
          }
          chunks.push(chunk);
        });
        message.on('end', () => {
          resolve(Buffer.concat(chunks).toString('utf8'));
        });
        message.on('error', reject);
      }),
  };
}

export function nodeServer(options: ServerOptions): Server {
  const timeouts = options.timeouts ?? TIMEOUTS;
  const maxBodyBytes = 1_048_576;

  const server = createServer(
    (message: IncomingMessage, reply: ServerResponse) => {
      const request = requestFrom(message, maxBodyBytes);

      // Provenance is minted by position 1, so the exchange handed in carries a
      // placeholder the chain immediately replaces. It is never observed.
      const exchange = {
        request,
        remaining: () => timeouts.read,
      } as unknown as Exchange;

      void options.handler(exchange).then(
        (response) => {
          reply.writeHead(response.status, response.headers);
          reply.end(response.body);
        },
        (error: unknown) => {
          // Only reachable if the chain itself threw, which position 3 exists
          // to prevent. Reported rather than swallowed.
          options.onError?.(error);
          if (!reply.headersSent) reply.writeHead(500);
          reply.end();
        },
      );
    },
  );

  // Values, not omissions. See `server.ts`.
  server.headersTimeout = timeouts.readHeader;
  server.requestTimeout = timeouts.read;
  server.keepAliveTimeout = timeouts.idle;

  // `headersTimeout` above is the documented lever and does not deliver on its
  // own. See `guard.ts`.
  guardHeaders(server, timeouts.readHeader);

  server.on('error', (error) => {
    options.onError?.(error);
  });

  return {
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(options.port, options.host, resolve);
      }),

    stop: () =>
      new Promise<void>((resolve, reject) => {
        // Stops accepting, then waits for in-flight requests — which is what
        // makes it a `lifecycle` step rather than a kill.
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
        server.closeIdleConnections();
      }),

    address() {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') return undefined;
      return { host: bound.address, port: bound.port };
    },
  };
}
