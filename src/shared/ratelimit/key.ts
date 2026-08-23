/**
 * Who is being limited. **L4 edge, and the trusted-proxy question lives here.**
 *
 * **The caller is the principal; the peer address is a fallback with a
 * precondition.** Conformance case 40 requires per-caller limits, which is why
 * position 7 sits below authn — a limiter that ran first would have no caller
 * to key on.
 *
 * See `notes/patterns/ratelimit.md`.
 */

import { ActorKind, type Provenance } from '../provenance/index.js';

const FORWARDED_FOR = 'x-forwarded-for';

/**
 * How far to trust `X-Forwarded-For`.
 *
 * **The default is to trust nothing, and that is the whole point of the shape.**
 * A deployment that has not thought about its proxy topology gets the safe
 * behaviour: the transport peer, which cannot be forged by a caller.
 *
 * Trusting the header unconditionally hands every caller a limit-evasion
 * primitive — a new address per request is a new bucket — and, worse, lets one
 * caller *exhaust another's* bucket by forging their address. The second is the
 * one that turns a throttle into a denial-of-service tool aimed at a specific
 * victim.
 */
export interface ProxyTrust {
  /**
   * How many proxies you operate in front of this process.
   *
   * **Zero means the header is ignored entirely.** Above zero, the client
   * address is counted from the **right**: `X-Forwarded-For` is appended to by
   * each hop, so with one trusted proxy the last entry is the address that
   * proxy observed and everything to its left is whatever the caller sent.
   *
   * Taking the *leftmost* entry is the classic version of this bug, and it is
   * the one that reads most naturally — the leftmost entry is described
   * everywhere as "the original client", which is true only if nobody lied.
   */
  readonly trustedProxyHops: number;
}

export const UNTRUSTED: ProxyTrust = { trustedProxyHops: 0 };

/**
 * The address the outermost trusted proxy observed.
 *
 * Returns `undefined` when the header cannot be trusted to that depth, so the
 * caller falls back to the transport peer rather than to a guess.
 */
export function forwardedFor(
  headers: Readonly<Record<string, string>>,
  trust: ProxyTrust,
): string | undefined {
  if (trust.trustedProxyHops <= 0) return undefined;

  const raw = headers[FORWARDED_FOR];
  if (raw === undefined) return undefined;

  const hops = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Count from the right. `hops` entries were appended by proxies we operate,
  // so the one at that depth is the last address we can vouch for.
  const index = hops.length - trust.trustedProxyHops;
  if (index < 0) {
    // Fewer entries than proxies claimed: the request did not come through the
    // topology this deployment describes, so nothing in the header is
    // attributable. The peer address is still true.
    return undefined;
  }
  return hops[index];
}

/**
 * The bucket key for this request.
 *
 * Prefixed by kind so an address can never collide with an actor id, and so an
 * operator reading a key knows immediately which of the two rules produced it.
 *
 * **The tenant is deliberately absent**, and that is an ordering fact rather
 * than an oversight: position 8 resolves the tenant and position 7 runs before
 * it. The principal already names one identity, and an anonymous caller has no
 * tenant to be keyed by.
 */
export function callerKey(
  provenance: Provenance,
  peer: string,
  headers: Readonly<Record<string, string>>,
  trust: ProxyTrust = UNTRUSTED,
): string {
  if (provenance.actor.kind !== ActorKind.Anonymous) {
    return `principal:${provenance.actor.toString()}`;
  }
  return `peer:${forwardedFor(headers, trust) ?? peer}`;
}
