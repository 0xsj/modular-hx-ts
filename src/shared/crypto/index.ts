/**
 * Keys, and the artefacts they produce. **L3 capability.**
 *
 * **The keyring is the module.** The primitives are library calls; what lives
 * here is the answer to *which key produced this, and how do I rotate without
 * invalidating history.*
 *
 * ```
 * v1.<kid>.<nonce>.<ct>   a ciphertext
 * v1.<kid>.<tag>          a MAC tag
 * v1.<kid>.<sig>          a signature
 * ```
 *
 * **Every artefact names its key.** It reads like overhead until you try to
 * rotate: without it, decryption means trying every key and no key can ever be
 * removed. This is the single design decision that makes the rest possible —
 * and these artefacts outlive the code, so getting it wrong leaves the mistake
 * in the database for years.
 *
 * **A ring per purpose**, so a compromised MAC key does not become a
 * compromised signing key. **Rotation is adding a key**, never invalidating old
 * ones.
 *
 * **AAD is required, never defaulted.** A ciphertext not bound to its row can
 * be moved between rows undetected.
 *
 * Note: `notes/patterns/crypto.md`.
 */

export {
  type Key,
  type Keyring,
  type KeysetSpec,
  type Ring,
  type RingSpec,
  PURPOSES,
  Purpose,
  ephemeralKeyring,
  keyring,
  parseKeyring,
} from './keyring.js';

export { type Aead, type Binding, keyIdOf, makeAead } from './aead.js';

export { type Mac, makeMac, tagKeyId } from './mac.js';

export {
  type Signer,
  makeSigner,
  publicKeyBytes,
  signatureKeyId,
} from './sign.js';

export { derive } from './derive.js';
