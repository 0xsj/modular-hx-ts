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
import { type ProxyTrust, NO_PROXIES, isTrusted } from './trust.js';

const FORWARDED_FOR = 'x-forwarded-for';
const REAL_IP = 'x-real-ip';

/**
 * The client address, walking `X-Forwarded-For` **right to left**.
 *
 * Each hop appends the address it saw, so the rightmost entry was written by
 * the proxy nearest this process. Skip entries that are inside the trusted set;
 * the **first one outside it** is the client, and everything to its left is
 * whatever the caller chose to send.
 *
 * Taking the *leftmost* entry is the classic version of this bug, and it reads
 * most naturally — the leftmost entry is described everywhere as "the original
 * client", which is true only if nobody lied.
 *
 * `undefined` when nothing is attributable, so the caller falls back to the
 * transport peer rather than to a guess.
 */
export function forwardedFor(
  peer: string,
  headers: Readonly<Record<string, string>>,
  trust: ProxyTrust,
): string | undefined {
  // **The immediate peer is the precondition.** A header from an untrusted peer
  // is a header the caller wrote, whatever it says.
  if (!isTrusted(peer, trust)) return undefined;

  const raw = headers[FORWARDED_FOR];
  if (raw !== undefined) {
    const hops = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');

    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = hops[index] ?? '';
      if (!isTrusted(hop, trust)) return hop;
    }
    // Every entry was one of ours, which means no client address is present.
    // The peer is still true.
    return undefined;
  }

  // **`X-Real-IP` loses to `X-Forwarded-For`, and is only read when it is
  // absent.** XFF carries a chain that can be *validated* by walking; this is a
  // single unverifiable assertion, and commonly a less accurate one — a proxy
  // typically sets it to its own immediate peer, which behind two proxies is
  // not the client.
  const real = headers[REAL_IP];
  return real === undefined || real.trim() === '' ? undefined : real.trim();
}

/**
 * Was a forwarding header present and ignored?
 *
 * **The failure this prevents is social.** Silently ignoring a populated header
 * looks like a bug, and the obvious fix somebody reaches for is to trust it
 * unconditionally — which is the limit-evasion primitive. Saying so, sampled,
 * is what stops that conversation from starting.
 */
export function ignoredForwarding(
  peer: string,
  headers: Readonly<Record<string, string>>,
  trust: ProxyTrust,
): boolean {
  const present =
    headers[FORWARDED_FOR] !== undefined || headers[REAL_IP] !== undefined;
  return present && !isTrusted(peer, trust);
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
  trust: ProxyTrust = NO_PROXIES,
): string {
  if (provenance.actor.kind !== ActorKind.Anonymous) {
    return `principal:${provenance.actor.toString()}`;
  }
  return `peer:${forwardedFor(peer, headers, trust) ?? peer}`;
}
