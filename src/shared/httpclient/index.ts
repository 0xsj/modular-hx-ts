/**
 * Outbound HTTP. **L2 substrate — the mirror of `httpx`.**
 *
 * One client over the platform's `fetch`:
 *
 * - a **per-attempt** timeout, never a total — a 30s budget spent as three 10s
 *   attempts is a different thing from one 30s attempt;
 * - retries of **only what is safe to replay** — the idempotent methods, or any
 *   request carrying an `Idempotency-Key`, which is the caller asserting the
 *   upstream will deduplicate it. A bare `POST` is never retried;
 * - `Retry-After` honoured over local backoff, because a server that says how
 *   long to wait knows something the client does not;
 * - provenance on the wire, with the **actor opt-in** — propagating who is
 *   acting to a third party is an information leak by default;
 * - status mapped to `Kind`, with **the upstream body never in the message**;
 * - response bodies capped, so a hostile or broken upstream cannot exhaust
 *   memory.
 *
 * **`breaker`'s first real caller**, per host and never global: one dead
 * endpoint must not stop the others, and a 4xx must not open a circuit — the
 * endpoint is up and rejecting you.
 *
 * Note: `notes/patterns/httpclient.md`.
 */

export {
  type ClientOptions,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
  makeClient,
} from './client.js';

export {
  IDEMPOTENCY_KEY,
  countsAgainstCircuit,
  isReplayable,
  isWorthRepeating,
  kindForStatus,
  retryAfter,
} from './policy.js';
