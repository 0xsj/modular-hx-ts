/**
 * The outbound HTTP client. **L2 substrate — the mirror of `httpx`.**
 *
 * One client over the platform's `fetch`, with a per-attempt timeout, bounded
 * retries of only what is safe to replay, provenance on the wire, status mapped
 * to `Kind`, and response bodies capped.
 *
 * **This is `breaker`'s first real caller.** The module has existed since the
 * 21st and had only ever been exercised by its own unit tests.
 *
 * See `notes/patterns/httpclient.md`.
 */

import { type Clock, type Millis, seconds } from '../clock/index.js';
import { type Breaker, isCircuitRejection } from '../breaker/index.js';
import { AppError, Kind } from '../errors/index.js';
import { Carrier } from '../provenance/index.js';
import { DEFAULT_POLICY, type Retrier } from '../retry/index.js';
import { isErr, type Result } from '../result/index.js';
import {
  countsAgainstCircuit,
  isReplayable,
  isWorthRepeating,
  kindForStatus,
  retryAfter,
} from './policy.js';

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /**
   * Send the acting actor to the upstream.
   *
   * **Off by default, and that is a security decision.** Propagating *who* is
   * acting to an arbitrary third party is an information leak — the recipient
   * learns your user identifiers for free — and it is unverifiable at the far
   * end anyway, so it grants the receiver nothing it should act on. Opt in per
   * request, for an upstream you control.
   */
  readonly forwardActor?: boolean;
  /** Overrides the client default for this request. */
  readonly timeout?: Millis;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  /** True when the body hit `maxBodyBytes` and was cut. */
  readonly truncated: boolean;
}

export interface ClientOptions {
  readonly clock: Clock;
  readonly retry: Retrier;
  readonly breaker: Breaker;
  /** **Per attempt**, never a total. See the note. */
  readonly timeout?: Millis;
  readonly attempts?: number;
  /** Refuses to read more than this from a response. */
  readonly maxBodyBytes?: number;
  /** Ceiling on an upstream-supplied `Retry-After`. */
  readonly maxRetryAfter?: Millis;
  readonly fetch?: typeof globalThis.fetch;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<Result<HttpResponse>>;
}

/** The host is the breaker key. Never global; never per-URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

/**
 * Read at most `limit` bytes, then stop.
 *
 * `response.text()` would buffer whatever the upstream sends, so a hostile or
 * broken server can exhaust memory with one reply. Reading the stream and
 * cancelling is the only way to bound it — `Content-Length` is a claim, not a
 * limit.
 */
async function readCapped(
  response: Response,
  limit: number,
): Promise<{ body: string; truncated: boolean }> {
  if (response.body === null) return { body: '', truncated: false };

  // `Response.body` is typed `ReadableStream<any>`, so every chunk arrives as
  // `any` and the whole loop below goes unchecked. Naming the element type is
  // the difference between a bounded read and one the compiler cannot see.
  const stream = response.body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      if (size + value.byteLength > limit) {
        chunks.push(value.subarray(0, limit - size));
        size = limit;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // Releases the connection rather than leaving it draining an upstream that
    // may never stop sending.
    await reader.cancel().catch(() => undefined);
  }

  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { body: new TextDecoder().decode(joined), truncated };
}

export function makeClient(options: ClientOptions): HttpClient {
  const { clock, retry, breaker } = options;
  const timeout = options.timeout ?? seconds(10);
  const attempts = options.attempts ?? 3;
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  const maxRetryAfter = options.maxRetryAfter ?? seconds(60);
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    async send(request: HttpRequest): Promise<Result<HttpResponse>> {
      const headers = new Headers(request.headers ?? {});

      // **Read from the ambient carrier**, because `httpclient` is an observer
      // rather than a stamper — `../../../PROVENANCE.md` §3 names it as one of
      // the three consumers permitted to.
      const provenance = Carrier.current();
      if (provenance !== undefined) {
        headers.set('x-correlation-id', provenance.correlationId);
        // The *parent* request id: the upstream's own request is the child.
        headers.set('x-causation-id', provenance.requestId);
        if (provenance.traceparent !== undefined) {
          headers.set('traceparent', provenance.traceparent);
        }
        if (request.forwardActor === true) {
          headers.set('x-actor', String(provenance.actor));
        }
      }

      const replayable = isReplayable(request.method, headers);
      const host = hostOf(request.url);

      let serverDelay: Millis | undefined;

      const attempt = async (): Promise<HttpResponse> => {
        // Inside the breaker, so **every attempt** feeds the window — a retry
        // that fails is a failure like any other.
        const guarded = await breaker.run(
          host,
          async () => {
            const controller = new AbortController();
            // **Per attempt.** A 30s budget spent as three 10s attempts is a
            // different thing from one 30s attempt: it gives three chances at a
            // flapping upstream, and it bounds how long any single socket may
            // hold a worker.
            const expiry = setTimeout(() => {
              controller.abort();
            }, request.timeout ?? timeout);

            let response: Response;
            try {
              response = await doFetch(request.url, {
                method: request.method,
                headers,
                ...(request.body === undefined ? {} : { body: request.body }),
                signal: controller.signal,
              });
            } catch (error) {
              const aborted =
                controller.signal.aborted ||
                (error as { name?: string }).name === 'AbortError';

              throw new AppError(
                aborted ? Kind.Timeout : Kind.Unavailable,
                aborted
                  ? `upstream ${host} did not answer within ${String(request.timeout ?? timeout)}ms`
                  : `upstream ${host} is unreachable`,
                { cause: error, details: { host, method: request.method } },
              );
            } finally {
              clearTimeout(expiry);
            }

            const { body, truncated } = await readCapped(
              response,
              maxBodyBytes,
            );

            if (response.status >= 400) {
              const kind = kindForStatus(response.status);
              serverDelay = retryAfter(
                response.headers,
                clock.now(),
                maxRetryAfter,
              );

              // **The upstream body never reaches the message.** It is
              // attacker-influenced on some paths and noise on all of them, and
              // it is how internal detail ends up in a log line somebody
              // screenshots. The status and the host are the whole message.
              const failure = new AppError(
                kind,
                `upstream ${host} returned ${String(response.status)}`,
                {
                  details: {
                    host,
                    status: response.status,
                    method: request.method,
                  },
                },
              );

              // A 4xx means the endpoint is **up** and rejecting us. Letting it
              // count would remove a working dependency because somebody typed
              // a bad id — so it is reported as a success to the breaker and a
              // failure to the caller.
              if (!countsAgainstCircuit(kind)) {
                return { rejected: failure } as const;
              }
              throw failure;
            }

            return {
              response: {
                status: response.status,
                headers: response.headers,
                body,
                truncated,
              },
            } as const;
          },
          `${request.method} ${host}`,
        );

        if (isErr(guarded)) throw guarded.error;
        if ('rejected' in guarded.value) throw guarded.value.rejected;
        return guarded.value.response;
      };

      return retry(attempt, `${request.method} ${host}`, {
        policy: {
          ...DEFAULT_POLICY,
          // A bare POST gets exactly one attempt.
          attempts: replayable ? attempts : 1,

          retryable: (error) => {
            // An **open circuit fails immediately** rather than consuming an
            // attempt: retrying against a breaker that is refusing precisely to
            // stop the traffic is the opposite of what opening it was for.
            if (isCircuitRejection(error)) return false;
            return isWorthRepeating(error.kind);
          },
        },

        // `Retry-After` beats local backoff whenever the server supplied one.
        delayFor: () => serverDelay,
      });
    },
  };
}
