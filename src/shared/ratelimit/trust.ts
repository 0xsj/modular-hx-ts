/**
 * Which proxies may speak for a caller. **CIDR prefixes, never a hop count.**
 *
 * `MODULES.md` §5. This file replaced a `trustedProxyHops: number`, and the
 * replacement is not a refinement — the two fail in opposite directions.
 *
 * **A hop count is positional, so it fails open under any topology change.**
 * `trustedProxyHops: 1` means *the last entry in `X-Forwarded-For` is the
 * client*. Add a second proxy, or let one request reach the process directly,
 * and the entry at that position is one the caller wrote. Nothing looks wrong:
 * the header is present, the count is satisfied, and the limiter is keying on
 * an attacker-supplied address. Prefixes fail **closed** in the same
 * situations — an address outside the trusted set ends the walk, and an
 * unrecognised topology falls back to the transport peer, which cannot be
 * forged.
 *
 * See `notes/patterns/ratelimit.md`.
 */

/** One CIDR prefix, parsed once at construction. */
interface Prefix {
  readonly bytes: Uint8Array;
  readonly bits: number;
}

export interface ProxyTrust {
  /**
   * The proxies you operate, as CIDR prefixes.
   *
   * **Empty is a legal, explicit answer** — it is what development uses, and it
   * means every forwarding header is ignored. What is not legal is leaving the
   * question unasked: see `trustedProxies`, which refuses rather than defaults.
   */
  readonly prefixes: readonly Prefix[];
}

/**
 * Parse a trusted set, or refuse.
 *
 * **There is no silent default, and both candidate defaults are wrong in the
 * same way.** Trusting headers by default hands every caller a limit-evasion
 * primitive — a new address per request is a new bucket — and lets one caller
 * exhaust another's bucket by forging their address. *Not* trusting them by
 * default is equally broken behind a load balancer, where every caller shares
 * one bucket and the limiter becomes global: it fails conformance case 40 on
 * the first day of any real deployment, while looking perfectly safe.
 *
 * So the set is stated explicitly, `'none'` is a legal explicit value, and an
 * absent setting refuses to boot — the same shape as an unresolvable secret.
 */
export function trustedProxies(setting: string | undefined): ProxyTrust {
  if (setting === undefined || setting.trim() === '') {
    throw new Error(
      'the trusted proxy set is not configured: set it to a comma-separated ' +
        'list of CIDR prefixes, or to `none` to ignore forwarding headers ' +
        'entirely. There is no default: trusting by default is a limit-evasion ' +
        'primitive, and not trusting by default makes the limiter global behind ' +
        'any load balancer.',
    );
  }

  if (setting.trim().toLowerCase() === 'none') return { prefixes: [] };

  const prefixes = setting
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map(parsePrefix);

  return { prefixes };
}

/** The explicit empty set. Development, and anything with no proxy in front. */
export const NO_PROXIES: ProxyTrust = { prefixes: [] };

function parsePrefix(entry: string): Prefix {
  const [address, width] = entry.split('/');
  const bytes = parseAddress(address ?? '');
  if (bytes === undefined) {
    throw new Error(`not an address: ${entry}`);
  }

  // A bare address is a host route — /32 or /128 — rather than an error. It is
  // what an operator means by naming one proxy.
  const bits = width === undefined ? bytes.length * 8 : Number(width);
  if (!Number.isInteger(bits) || bits < 0 || bits > bytes.length * 8) {
    throw new Error(`not a prefix length for this family: ${entry}`);
  }

  return { bytes, bits };
}

/**
 * An address as bytes, IPv4 or IPv6.
 *
 * **An IPv4-mapped IPv6 address becomes its four bytes**, so a `10.0.0.0/8`
 * prefix matches a peer that arrived as `::ffff:10.0.0.1`. Node reports exactly
 * that form on a dual-stack listener, so without this the trusted set silently
 * matches nothing in the deployment most likely to have proxies in front.
 */
function parseAddress(raw: string): Uint8Array | undefined {
  const value = raw.trim().replace(/^\[|]$/g, '');
  if (value === '') return undefined;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(value);
  if (mapped?.[1] !== undefined) return parseAddress(mapped[1]);

  if (value.includes(':')) return parseIpv6(value);
  return parseIpv4(value);
}

function parseIpv4(value: string): Uint8Array | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;

  const bytes = new Uint8Array(4);
  for (const [index, part] of parts.entries()) {
    // `Number('')` is 0 and `Number('01')` is 1: neither is an address, and
    // both would widen a prefix somebody wrote carefully.
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    bytes[index] = octet;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | undefined {
  const halves = value.split('::');
  if (halves.length > 2) return undefined;

  const groups = (part: string | undefined): string[] =>
    part === undefined || part === '' ? [] : part.split(':');

  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const filled = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : filled < 0) return undefined;

  const all = [
    ...head,
    ...(halves.length === 2 ? Array<string>(filled).fill('0') : []),
    ...tail,
  ];

  const bytes = new Uint8Array(16);
  for (const [index, group] of all.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const word = Number.parseInt(group, 16);
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

/** Is this address inside the trusted set? */
export function isTrusted(address: string, trust: ProxyTrust): boolean {
  const bytes = parseAddress(address);
  if (bytes === undefined) return false;

  return trust.prefixes.some((prefix) => within(bytes, prefix));
}

function within(address: Uint8Array, prefix: Prefix): boolean {
  // A v4 address is never inside a v6 prefix and the reverse: comparing them
  // byte-wise would make `10.0.0.0/8` match an unrelated v6 address.
  if (address.length !== prefix.bytes.length) return false;

  const whole = Math.floor(prefix.bits / 8);
  for (let index = 0; index < whole; index += 1) {
    if (address[index] !== prefix.bytes[index]) return false;
  }

  const remainder = prefix.bits % 8;
  if (remainder === 0) return true;

  const mask = 0xff << (8 - remainder);
  return ((address[whole] ?? 0) & mask) === ((prefix.bytes[whole] ?? 0) & mask);
}
