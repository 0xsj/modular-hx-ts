/**
 * HMAC-SHA256 tags. **L3 capability.**
 *
 * Challenge tokens and session fingerprints — which is why `crypto` is needed
 * before `identity`.
 *
 * `v1.<kid>.<tag>`, for the same reason a ciphertext names its key: a tag
 * produced under a retired key must still verify, and a key can only be removed
 * once nothing names it.
 *
 * See `notes/patterns/crypto.md`.
 */

import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { Purpose, type Key, type Keyring } from './keyring.js';

const VERSION = 'v1';

const compute = (key: Key, message: string): Buffer =>
  createHmac('sha256', key.material).update(message, 'utf8').digest();

export interface Mac {
  /** `v1.<kid>.<tag>` over `message`, under the current key. */
  tag(message: string): Result<string>;
  /** Whether `token` is a tag this keyring produced for `message`. */
  verify(message: string, token: string): boolean;
}

export function makeMac(keys: Keyring): Mac {
  return {
    tag(message) {
      const ring = keys.ring(Purpose.Mac);
      if (!ring.ok) return err(ring.error);
      const key = ring.value.current();

      return ok(
        [VERSION, key.id, compute(key, message).toString('base64url')].join(
          '.',
        ),
      );
    },

    verify(message, token) {
      // **Boolean, not `Result`.** Every failure is one answer: a malformed
      // token, an unknown key and a wrong tag must be indistinguishable, and a
      // typed error would tell an attacker which of the three they hit.
      const parts = token.split('.');
      if (parts.length !== 3 || parts[0] !== VERSION) return false;

      const [, kid, tag64] = parts as [string, string, string];

      const ring = keys.ring(Purpose.Mac);
      if (!ring.ok) return false;

      const key = ring.value.byId(kid);
      if (!key.ok) return false;

      const expected = compute(key.value, message);
      const supplied = Buffer.from(tag64, 'base64url');

      // Length first: `timingSafeEqual` throws on a mismatch, and the length of
      // a tag is not a secret.
      if (supplied.byteLength !== expected.byteLength) return false;

      // **Constant time.** A `===` on the encoded strings returns early at the
      // first differing byte, which is enough to forge a tag one byte at a time
      // given enough attempts.
      return timingSafeEqual(supplied, expected);
    },
  };
}

/** The key id a token names, without verifying it. For a rotation audit. */
export function tagKeyId(token: string): Result<string> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return err(invalid('not a v1 tag'));
  }
  return ok(parts[1] ?? '');
}
