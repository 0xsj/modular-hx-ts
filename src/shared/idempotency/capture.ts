/**
 * What of a response is safe to store. **L4 edge.**
 *
 * **Store only headers the response owns, never per-request ones.** A replayed
 * `date` or `x-request-id` from the original request is a lie about the
 * response the caller is holding right now: it points a support conversation at
 * a log line for somebody else's request, which is worse than having no header
 * at all.
 *
 * An **allowlist**, not a denylist. A header nobody thought about is dropped
 * rather than replayed, which is the fail-closed reading and the same shape
 * `provenance` uses for adoption. The cost of a wrongly-dropped header is a
 * client that has to ask again; the cost of a wrongly-kept one is a response
 * that misdescribes itself.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { type Response } from '../edge/index.js';

/**
 * Headers that describe **the representation**, not the exchange that carried
 * it.
 *
 * `set-cookie` is deliberately absent and is the one worth naming: it is
 * per-session by definition, and replaying one hands a second caller the first
 * caller's session.
 */
const OWNED: readonly string[] = [
  'content-type',
  'content-language',
  'content-encoding',
  'etag',
  'last-modified',
  'location',
  'cache-control',
  'vary',
  'link',
  'retry-after',
];

export function storableHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    if (OWNED.includes(name.toLowerCase())) kept[name.toLowerCase()] = value;
  }
  return kept;
}

/**
 * How large a response may be and still be replayable.
 *
 * **Not a policy knob.** Replay means buffering, which is what the late-error
 * rule says not to do; the two are reconciled by *scope* — only a request
 * carrying a key is buffered, and an endpoint that streams must not accept one.
 * So exceeding this is a wiring mistake rather than a runtime condition.
 */
export const MAX_STORED_BYTES = 256 * 1024;

/** Bytes on the wire, which is what the cap is about — not characters. */
export function storedSize(response: Response): number {
  return Buffer.byteLength(response.body, 'utf8');
}

export function exceedsCap(response: Response): boolean {
  return storedSize(response) > MAX_STORED_BYTES;
}

/**
 * What a developer needs to read to fix it.
 *
 * **Silently declining to store is the failure mode**: the request succeeds,
 * the client believes it is protected, and the guarantee is gone with nothing
 * anywhere saying so. So the response goes through — it is a real answer to a
 * real request, and turning a success into a 500 would tell the client its
 * write failed when it did not — and this goes to the log at error level.
 *
 * The key is **consumed rather than released**. Releasing means the next retry
 * re-executes and double-applies the write, which is the one thing this module
 * exists to prevent: **losing replay is a cost, losing the guarantee is a
 * failure.**
 */
export function capExceeded(response: Response, path: string): string {
  return (
    `${path} answered ${String(storedSize(response))} bytes and accepted an ` +
    `Idempotency-Key; the replay cap is ${String(MAX_STORED_BYTES)}. The ` +
    `response was returned and the key spent, so a retry cannot double-apply ` +
    `it — but it cannot be replayed either. An endpoint this large must not ` +
    `accept a key`
  );
}
