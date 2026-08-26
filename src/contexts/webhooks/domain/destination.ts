/**
 * Is this URL one we will fetch? **`webhooks` domain.**
 *
 * A webhook endpoint is **a caller-supplied URL the server fetches on a
 * schedule**, which is the textbook shape of server-side request forgery. The
 * caller picks the host; the request originates inside our network, carries our
 * source address, and reaches whatever that address can reach — cloud metadata
 * services, internal admin panels, a database's HTTP port.
 *
 * So four rules, and each one closes a specific door:
 *
 * - **`https` only.** A webhook body is signed but not encrypted, and it
 *   carries whatever the event carries. `http` publishes it to every hop.
 * - **No credentials in the URL.** `https://user:pass@host/` puts a secret in
 *   a column, in a list response, and in every log line that prints the
 *   destination. If an endpoint needs a credential it belongs in a header.
 * - **No loopback, link-local, or private address literal.** `127.0.0.1`,
 *   `::1`, `169.254.169.254` — the metadata address — and the RFC 1918 ranges.
 * - **No fragment, and a host that is actually there.** A fragment is never
 *   sent, so accepting one stores a destination that is not the destination.
 *
 * **This is not sufficient and does not pretend to be.** A name that resolves
 * to a private address defeats every check here, because resolution happens
 * later and can change between the check and the connection — the DNS-rebinding
 * shape. The complete answer pins the resolved address at connect time, which
 * is a property of the *dialer* and belongs in `httpclient` with the rest of
 * the transport. What this file buys is that the obvious attempt fails at
 * registration, loudly, in front of the person making it — rather than
 * succeeding and being discovered in an outbound access log.
 */

import { invalid } from '../../../shared/errors/index.js';

const PRIVATE_V4 =
  /^(?:10\.|127\.|169\.254\.|192\.168\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

function refuse(why: string): never {
  throw invalid(`not a usable webhook destination: ${why}`, [
    { field: 'url', message: why },
  ]);
}

export function checkDestination(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse('is not a URL');
  }

  if (url.protocol !== 'https:') refuse('must be https');
  if (url.username !== '' || url.password !== '') {
    refuse('must not carry credentials in the URL');
  }
  if (url.hash !== '') refuse('must not carry a fragment');
  if (url.hostname === '') refuse('has no host');

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost')) {
    refuse('must not be loopback');
  }
  if (PRIVATE_V4.test(host))
    refuse('must not be a private or loopback address');
  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80:')) {
    refuse('must not be a private or loopback address');
  }
  // `::ffff:127.0.0.1` — the same address wearing a v6 hat, and the reason the
  // v4 check alone is not enough.
  //
  // **And it does not arrive in the form it was written.** WHATWG URL parsing
  // normalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1`, so a check that looked
  // for a dotted quad after the prefix matched nothing at all and the address
  // sailed through. The test found it; reading the code did not.
  const mapped = mappedV4(host);
  if (mapped !== undefined && PRIVATE_V4.test(mapped)) {
    refuse('must not be a private or loopback address');
  }
}

/**
 * `::ffff:7f00:1` and `::ffff:127.0.0.1` → `127.0.0.1`. Anything else →
 * `undefined`.
 */
function mappedV4(host: string): string | undefined {
  if (!host.startsWith('::ffff:')) return undefined;
  const suffix = host.slice('::ffff:'.length);

  if (suffix.includes('.')) return suffix;

  const groups = suffix.split(':');
  if (groups.length !== 2) return undefined;

  const octets = groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return Number.isNaN(value) ? [] : [value >> 8, value & 0xff];
  });
  return octets.length === 4 ? octets.join('.') : undefined;
}
