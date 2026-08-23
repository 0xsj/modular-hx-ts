/**
 * Field encryption. **L3 capability.**
 *
 * ```
 * v1.<kid>.<nonce>.<ciphertext+tag>
 * ```
 *
 * **Self-describing, and every part earns its place.**
 *
 * - `v1` — a version, so the format can change. Four bytes now, and the
 *   difference between a migration and a rewrite later.
 * - `<kid>` — **the key id**, so rotation works. Without it, decryption means
 *   trying every key and no key can ever be removed. This is the single
 *   decision that makes the rest possible.
 * - `<nonce>` — fresh per encryption, because reusing one under AES-GCM leaks
 *   the XOR of two plaintexts and destroys the authentication guarantee.
 *
 * Parsed strictly: anything this module did not produce is refused rather than
 * interpreted.
 *
 * See `notes/patterns/crypto.md`.
 */

import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { invalid, wrap } from '../errors/index.js';
import { type Random } from '../random/index.js';
import { err, ok, type Result } from '../result/index.js';
import { Purpose, type Keyring } from './keyring.js';

const VERSION = 'v1';
const NONCE_BYTES = 12; // GCM's standard, and the only size it is fast for.
const TAG_BYTES = 16;

/**
 * What the ciphertext is bound to.
 *
 * **Required, never defaulted to empty**, and that is the point of the type.
 * Encrypting a column without binding it to its row means a ciphertext can be
 * **moved between rows undetected** — swap two users' encrypted fields and both
 * decrypt cleanly, each returning the other's data with no error anywhere.
 *
 * An empty AAD *is* the failure, so a required parameter is the only reliable
 * way to make a caller think about it. There is deliberately no convenience
 * overload without one.
 */
export interface Binding {
  readonly tenant: string;
  /** The table or collection — `users`, `payment_methods`. */
  readonly table: string;
  /** The row this value belongs to. */
  readonly id: string;
  /** The column, so two encrypted fields on one row cannot be swapped either. */
  readonly field: string;
}

/** The AAD bytes. Canonical and unambiguous: separators cannot appear in it. */
/**
 * The AAD field separator: ASCII **unit separator**.
 *
 * Written as an escape, never as a literal byte. A raw control character
 * in a source file makes the file binary to every text tool — which has now
 * happened three times in this repository, and `tests/rules/encoding.test.ts`
 * caught this one by name.
 *
 * A control character rather than a space because it cannot occur in a tenant
 * id, a table name, a row id or a column name — so the joined AAD is
 * unambiguous rather than merely unlikely to collide. Any field containing it
 * is refused.
 */
const SEPARATOR = '\u001f';

function aad(binding: Binding): Buffer {
  // Named rather than iterated: `Object.entries` on an interface widens each
  // value to `any`. Naming them also keeps this check and the join below
  // reading off one list, so they cannot drift apart.
  const parts: readonly (readonly [string, string])[] = [
    ['tenant', binding.tenant],
    ['table', binding.table],
    ['id', binding.id],
    ['field', binding.field],
  ];

  for (const [name, part] of parts) {
    if (part.includes(SEPARATOR)) {
      throw invalid(`binding.${name} contains the AAD separator`);
    }
  }

  return Buffer.from(parts.map(([, part]) => part).join(SEPARATOR), 'utf8');
}

export interface Aead {
  encrypt(plaintext: string, binding: Binding): Result<string>;
  decrypt(envelope: string, binding: Binding): Result<string>;
}

export function makeAead(keys: Keyring, random: Random): Aead {
  return {
    encrypt(plaintext, binding) {
      const ring = keys.ring(Purpose.Encryption);
      if (!ring.ok) return err(ring.error);
      const key = ring.value.current();

      let bound: Buffer;
      try {
        bound = aad(binding);
      } catch (error) {
        return err(wrap(error, 'the binding is unusable'));
      }

      // From the injected source, per rule `I5` — which also makes nonce
      // uniqueness testable rather than assumed.
      const nonce = random.bytes(NONCE_BYTES);

      const cipher = createCipheriv('aes-256-gcm', key.material, nonce);
      cipher.setAAD(bound);
      const body = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);

      return ok(
        [
          VERSION,
          key.id,
          Buffer.from(nonce).toString('base64url'),
          body.toString('base64url'),
        ].join('.'),
      );
    },

    decrypt(envelope, binding) {
      const parts = envelope.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) {
        // Strict: anything this module did not produce is refused rather than
        // interpreted. The value is never echoed — it is a ciphertext.
        return err(invalid('not a v1 ciphertext'));
      }

      const [, kid, nonce64, body64] = parts as [
        string,
        string,
        string,
        string,
      ];

      const ring = keys.ring(Purpose.Encryption);
      if (!ring.ok) return err(ring.error);

      // **Rotation lives here.** The artefact names its key, so a value written
      // under a retired key decrypts without trying anything else — and a key
      // can be removed once nothing names it.
      const key = ring.value.byId(kid);
      if (!key.ok) return err(key.error);

      let bound: Buffer;
      try {
        bound = aad(binding);
      } catch (error) {
        return err(wrap(error, 'the binding is unusable'));
      }

      const nonce = Buffer.from(nonce64, 'base64url');
      const body = Buffer.from(body64, 'base64url');
      if (nonce.byteLength !== NONCE_BYTES || body.byteLength < TAG_BYTES) {
        return err(invalid('ciphertext is malformed'));
      }

      const tag = body.subarray(body.byteLength - TAG_BYTES);
      const ciphertext = body.subarray(0, body.byteLength - TAG_BYTES);

      try {
        const decipher = createDecipheriv(
          'aes-256-gcm',
          key.value.material,
          nonce,
        );
        decipher.setAAD(bound);
        decipher.setAuthTag(tag);
        return ok(
          Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ]).toString('utf8'),
        );
      } catch {
        // One message for every failure: a wrong key, a tampered ciphertext and
        // a mismatched binding are indistinguishable to the caller, because
        // distinguishing them is an oracle.
        return err(invalid('ciphertext could not be decrypted'));
      }
    },
  };
}

/** The key id an envelope names, without decrypting it. For a rotation audit. */
export function keyIdOf(envelope: string): Result<string> {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    return err(invalid('not a v1 ciphertext'));
  }
  return ok(parts[1] ?? '');
}
