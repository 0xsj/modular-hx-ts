/**
 * The server port, and its timeouts. **L4 edge.**
 *
 * **Timeouts are the server's, and they are not the handler's.** Read-header,
 * read, write and idle belong to the server configuration and must have
 * *values* rather than defaults-by-omission: a server with no read-header
 * timeout is a slowloris away from having no capacity, and Node's default for
 * `requestTimeout` and `headersTimeout` has changed between majors — relying on
 * it is relying on a number nobody wrote down.
 *
 * These are **distinct from position 5's per-request budget**. Both exist and
 * they do different jobs: the server's protect the process from a peer that
 * will not finish speaking; the budget bounds the work a handler is allowed to
 * do once it has.
 *
 * See `notes/patterns/httpx.md`.
 */

import { type Millis, seconds } from '../clock/index.js';
import { type Handler } from '../edge/index.js';

export interface Timeouts {
  /** How long a peer may take to finish sending headers. The slowloris one. */
  readonly readHeader: Millis;
  /** How long the whole request may take to arrive. */
  readonly read: Millis;
  /** How long a response may take to write. */
  readonly write: Millis;
  /** How long an idle keep-alive connection is held. */
  readonly idle: Millis;
}

/**
 * Values, not omissions.
 *
 * Every one of these is written down so a reader can disagree with a number
 * rather than discover a default.
 */
export const TIMEOUTS: Timeouts = {
  readHeader: seconds(10),
  read: seconds(30),
  write: seconds(30),
  // Longer than a typical load balancer's, so the balancer closes first and
  // the client never races a half-closed connection.
  idle: seconds(75),
};

export interface ServerOptions {
  readonly host: string;
  readonly port: number;
  readonly handler: Handler;
  readonly timeouts?: Timeouts;
  /** Reported when a connection fails outside any request. */
  readonly onError?: (error: unknown) => void;
}

export interface Server {
  /** Resolves once the socket is accepting. */
  start(): Promise<void>;
  /** Stops accepting and waits for in-flight requests. A `lifecycle` step. */
  stop(): Promise<void>;
  /** The bound port — useful when `port` was 0. */
  address(): { host: string; port: number } | undefined;
}
