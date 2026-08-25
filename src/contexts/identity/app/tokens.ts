/**
 * Minting a secret, and storing only its shadow. **`identity` app.**
 *
 * **The store never holds a usable token.** `random` generates it, `digest`
 * fingerprints it, and only the fingerprint is written — so a database dump
 * yields no sessions, no API keys and no challenge secrets. Conformance case 16
 * says an API key is shown once and never returned again, and that is only true
 * if it *cannot* be returned.
 *
 * One helper rather than three, because session tokens, API keys and challenge
 * secrets differ in lifetime and in nothing else. Three would drift, and the
 * one that drifted would be the one somebody stored raw.
 *
 * See `notes/domain/identity.md`.
 */

import { digestOfBytes } from '../../../shared/digest/index.js';
import {
  type Random,
  constantTimeEqual,
} from '../../../shared/random/index.js';

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
