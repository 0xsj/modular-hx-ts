/**
 * The slowloris guard. **L4 edge, and it exists because a documented lever did
 * not work.**
 *
 * `server.ts` claims that *a server with no read-header timeout is a slowloris
 * away from having no capacity*. Node's `headersTimeout` is the documented way
 * to deliver that, and this repository sets it — but on Node 22.21 a peer that
 * opened a connection and stalled mid-headers was still connected ten seconds
 * later in every configuration measured, including with `requestTimeout` set
 * and `connectionsCheckingInterval` lowered to 100ms. A socket-level
 * inactivity timer fires as documented, so the guard is written explicitly.
 *
 * **Armed on connect, released once the headers arrive**, so it bounds the
 * slowloris window and nothing else: a handler that takes a minute is not this
 * timer's business, and `keepAliveTimeout` owns the connection once a response
 * is written.
 *
 * Applied by both adapters, to the same `http.Server` underneath either — which
 * is how *the observable behaviour must not vary* survives contact with a
 * framework that has its own opinion about connection timeouts.
 *
 * See `notes/patterns/httpx.md`.
 */

import { type Server as HttpServer } from 'node:http';
import { type Millis } from '../clock/index.js';

export function guardHeaders(server: HttpServer, readHeader: Millis): void {
  server.on('connection', (socket) => {
    socket.setTimeout(readHeader, () => {
      // Nothing to report and nobody to report it to: the peer never said what
      // it wanted, so there is no request, no provenance and no problem body.
      socket.destroy();
    });
  });

  server.on('request', (request) => {
    // Headers are in. Releasing the guard here is the whole reason it is armed
    // per-connection rather than set as a server-wide `setTimeout`, which would
    // also kill a handler that is thinking.
    request.socket.setTimeout(0);
  });
}
