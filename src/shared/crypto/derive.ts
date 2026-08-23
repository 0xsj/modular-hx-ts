/**
 * HKDF sub-key derivation. **L3 capability.**
 *
 * One ring serving several uses **without new key material**. A session
 * fingerprint and a CSRF token both want a MAC key, and deriving them from one
 * ring with different `info` strings means one thing to rotate rather than two
 * to keep in step.
 *
 * The `info` string is what separates the uses, so it must be distinct and
 * stable: changing it invalidates everything derived under the old one, exactly
 * as changing a key would.
 *
 * See `notes/patterns/crypto.md`.
 */

import { Buffer } from 'node:buffer';
import { hkdfSync } from 'node:crypto';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { type Key } from './keyring.js';

/**
 * A sub-key of `key`, for `info`.
 *
 * No salt: the input is already uniformly random key material rather than a
 * password, which is the case RFC 5869 §3.1 says a salt is optional for. A
 * salt that varied per call would make the derivation non-reproducible, which
 * is the opposite of what a sub-key needs.
 */
export function derive(key: Key, info: string, bytes = 32): Result<Uint8Array> {
  if (info === '') {
    // An empty `info` makes every use the same sub-key, which defeats the
    // separation this exists for.
    return err(invalid('a derived key names its use'));
  }
  if (bytes < 16 || bytes > 64) {
    return err(invalid(`a derived key is 16-64 bytes, not ${String(bytes)}`));
  }

  const derived = hkdfSync(
    'sha256',
    key.material,
    Buffer.alloc(0),
    Buffer.from(info, 'utf8'),
    bytes,
  );
  return ok(new Uint8Array(derived));
}
