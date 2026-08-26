/**
 * Minting a bearer secret, and storing only its shadow. **L0 kernel.**
 *
 * **The store never holds a usable token.** `random` generates it, `digest`
 * fingerprints it, and only the fingerprint is written — so a database dump
 * yields no sessions, no API keys, no challenge secrets and no invitations.
 * Conformance case 16 says an API key is shown once and never returned again,
 * and that is only true if it *cannot* be returned.
 *
 * **This is a promotion, and the third context is what forced it.** It lived in
 * `identity/app/tokens.ts`, and `orgs` needed the identical thing for an
 * invitation. `S6` makes a context\'s code unreachable from the next one, so the
 * choice was a second copy or a shared module — and the collection\'s own rule
 * is that the **second copy** is the trigger.
 *
 * **What could not be promoted is the more interesting half.** `CONTEXTS.md` §4
 * calls an invitation *the `Challenge` shape again*, and the `Challenge`
 * **aggregate** cannot be shared: `S7` permits a context\'s `domain/` exactly
 * one import, `errors`, so no shared module is reachable from where an
 * aggregate lives. That is the rule working rather than failing — an aggregate
 * is a context\'s own model, and two contexts sharing one would be two contexts
 * with one model. What is genuinely common is the *mechanics*, which have no
 * domain in them at all, and that is what this is.
 *
 * See `notes/patterns/token.md`.
 */

import { digestOfBytes } from '../digest/index.js';
import { type Random, constantTimeEqual } from '../random/index.js';

/** 32 bytes — 256 bits — which is the size below which nobody has to think. */
const TOKEN_BYTES = 32;

export interface Secret {
  /** Shown to the caller exactly once. Never stored, never logged. */
  readonly raw: string;
  /** `sha256:` of the raw value. This is what a repository holds. */
  readonly fingerprint: string;
}

export function mintSecret(random: Random, bytes = TOKEN_BYTES): Secret {
  const raw = random.token(bytes);
  return { raw, fingerprint: fingerprintOf(raw) };
}

/**
 * The one-way step.
 *
 * A plain SHA-256 rather than a password hash, and the difference matters: a
 * password is low-entropy and needs work factors to survive a dump, while a
 * 256-bit random token is not guessable and a memory-hard hash on the
 * **per-request** session lookup would be a self-inflicted denial of service.
 */
export function fingerprintOf(raw: string): string {
  return digestOfBytes(new TextEncoder().encode(raw));
}

/**
 * Compare a presented secret against a stored fingerprint.
 *
 * Constant-time, and the reason is narrower than it looks: the lookup is by
 * fingerprint through an index, so the database has already leaked timing by
 * finding the row or not. This closes the remaining comparison, and costs
 * nothing.
 */
export function secretMatches(raw: string, fingerprint: string): boolean {
  return constantTimeEqual(fingerprintOf(raw), fingerprint);
}

/**
 * ASCII unit separator, U+001F. **An escape, never a literal byte.**
 *
 * A raw control character makes the file binary to every text tool: `grep`
 * skips it, an editor eats it, and the only thing that catches it is
 * `tests/rules/encoding.test.ts`. This repository has written one by accident
 * five times.
 */
const SEPARATOR = '\u001f';

/**
 * What a MAC is computed over. **Joined unambiguously.**
 *
 * Every part of a token\'s identity goes in, and binding them together is the
 * point: without the purpose, a password-reset secret and a magic-link secret
 * are interchangeable and the weaker flow becomes the way into the stronger
 * one; without the subject, a token can be moved between accounts or between
 * organizations.
 *
 * The separator cannot occur in any part, so the join needs no rejection rule —
 * which is what makes this safe to hand a caller-supplied string.
 */
export function bind(...parts: readonly string[]): string {
  return parts.join(SEPARATOR);
}
