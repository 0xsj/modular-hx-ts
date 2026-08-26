/**
 * How a receiver knows the request came from here. **`webhooks` domain.**
 *
 * Three headers, and the shape is deliberately the one the ecosystem already
 * has — a receiver should be able to verify these with a library they already
 * use rather than with code they wrote from our prose:
 *
 *     Webhook-Id:        <delivery id, stable across every retry>
 *     Webhook-Timestamp: <unix seconds>
 *     Webhook-Signature: v1,<base64 hmac-sha256>
 *
 * **The signed message is `id.timestamp.body`, and every part earns its place.**
 *
 * - The **body** is the point.
 * - The **timestamp** is what lets a receiver refuse a replay. Without it, a
 *   signature is valid forever and anybody who ever saw one request can send it
 *   again in a year.
 * - The **id** binds the signature to *this delivery*, so a body that is
 *   byte-identical for two different events — which happens, `{}` is a body —
 *   cannot have one's signature moved onto the other.
 *
 * **Concatenation with a separator that cannot appear in the parts.** The id is
 * a UUID and the timestamp is digits, so a `.` between them is unambiguous.
 * Concatenating without one is the classic length-extension-adjacent mistake:
 * `("a", "bc")` and `("ab", "c")` sign the same bytes.
 *
 * **The signature is a list, not a value.** `v1,<sig>` with room for
 * `v1,<new> v1,<old>` during a rotation — a receiver takes the first that
 * verifies, so a secret can be rotated without a flag day. That is the reason
 * for the shape; this context sends one today.
 *
 * `S7` — this directory imports only `errors`, so the MAC itself is passed in
 * as a function by the app layer rather than reached for here.
 */

/** The three header names, spelled once. */
export const SIGNATURE_HEADERS = {
  Id: 'webhook-id',
  Timestamp: 'webhook-timestamp',
  Signature: 'webhook-signature',
} as const;

/**
 * The bytes a signature covers.
 *
 * Exported and tested directly, because *what exactly is signed* is the one
 * thing a receiver has to reimplement, and a mistake here is invisible until
 * somebody else's verification fails against a signature that looks fine.
 */
export function signedMessage(
  deliveryId: string,
  timestampSeconds: number,
  body: string,
): string {
  return `${deliveryId}.${String(timestampSeconds)}.${body}`;
}

/** Whole seconds, which is what the header carries and therefore what is signed. */
export function timestampFor(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

export function signatureHeader(signature: string): string {
  return `v1,${signature}`;
}
