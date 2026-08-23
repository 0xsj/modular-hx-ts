/**
 * Ed25519 signatures. **L3 capability.**
 *
 * `v1.<kid>.<signature>`, and the public key is exportable so a verifier that
 * holds no secret can check one.
 *
 * **The stored material is a 32-byte seed**, not a DER private key. The key
 * pair derives from it deterministically, so the same seed produces the same
 * public key in Go, Python and here — which is what makes a signature written
 * by one blueprint verifiable by another.
 *
 * See `notes/patterns/crypto.md`.
 */

import { Buffer } from 'node:buffer';
import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { Purpose, type Key, type Keyring } from './keyring.js';

const VERSION = 'v1';

// PKCS#8 and SPKI wrappers for a raw Ed25519 seed and public key. Fixed bytes,
// defined by RFC 8410 — this is the standard way to hand a raw key to a library
// that only speaks DER, and it is why the seed is portable.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFrom(key: Key): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(key.material)]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The raw 32-byte public key for a seed. */
export function publicKeyBytes(key: Key): Uint8Array {
  const spki = createPublicKey(privateKeyFrom(key)).export({
    format: 'der',
    type: 'spki',
  });
  return new Uint8Array(spki.subarray(SPKI_PREFIX.byteLength));
}

export interface Signer {
  sign(message: string): Result<string>;
  verify(message: string, signature: string): boolean;
  /**
   * `kid -> base64url public key`, for every key on the ring.
   *
   * What a verifier is given. Exportable because a signature is only useful if
   * somebody who holds no secret can check it — and because retired keys must
   * stay published, or last year's signature becomes unverifiable.
   */
  publicKeys(): Result<Readonly<Record<string, string>>>;
}

export function makeSigner(keys: Keyring): Signer {
  return {
    sign(message) {
      const ring = keys.ring(Purpose.Signing);
      if (!ring.ok) return err(ring.error);
      const key = ring.value.current();

      const signature = edSign(
        null,
        Buffer.from(message, 'utf8'),
        privateKeyFrom(key),
      );

      return ok([VERSION, key.id, signature.toString('base64url')].join('.'));
    },

    verify(message, signature) {
      const parts = signature.split('.');
      if (parts.length !== 3 || parts[0] !== VERSION) return false;

      const [, kid, sig64] = parts as [string, string, string];

      const ring = keys.ring(Purpose.Signing);
      if (!ring.ok) return false;

      const key = ring.value.byId(kid);
      if (!key.ok) return false;

      try {
        return edVerify(
          null,
          Buffer.from(message, 'utf8'),
          createPublicKey(privateKeyFrom(key.value)),
          Buffer.from(sig64, 'base64url'),
        );
      } catch {
        return false;
      }
    },

    publicKeys() {
      const ring = keys.ring(Purpose.Signing);
      if (!ring.ok) return err(ring.error);

      const out: Record<string, string> = {};
      for (const id of ring.value.ids()) {
        const key = ring.value.byId(id);
        if (!key.ok) continue;
        out[id] = Buffer.from(publicKeyBytes(key.value)).toString('base64url');
      }
      return ok(out);
    },
  };
}

/** The key id a signature names, without verifying it. */
export function signatureKeyId(signature: string): Result<string> {
  const parts = signature.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return err(invalid('not a v1 signature'));
  }
  return ok(parts[1] ?? '');
}
