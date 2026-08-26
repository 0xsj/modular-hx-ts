/**
 * Signing secrets. **`webhooks` infra.**
 *
 * The port says two things — mint one, sign with it — and the reason it is a
 * port rather than a field is that **this context never holds the secret**. It
 * holds a fingerprint; signing happens where the key lives.
 *
 * ## The derivation, and why there is one
 *
 * A secret is not stored at all. It is **derived** from a stored nonce under
 * the installation's MAC keyring:
 *
 *     secret       = mac("webhooks.secret.v1." + nonce)      // keyring key
 *     fingerprint  = mac("webhooks.fingerprint.v1." + secret) + ":" + nonce
 *     signature    = HMAC-SHA256(key = secret, message)      // the SECRET
 *
 * So there is no column an attacker can read to forge a signature — the nonce
 * alone is worth nothing without the installation key — and rotation is a new
 * nonce rather than a new column.
 *
 * **The signature is keyed by the secret, not by the keyring**, and that line
 * was wrong in the first version of this file. It computed the signature as
 * another keyring MAC over the secret and the message, which produces a tag a
 * receiver **cannot verify**: they hold `whsec_…` and not the installation key,
 * so they can compute nothing. A signing scheme the recipient cannot check is
 * not a signing scheme, and every test of the sending side would have passed.
 *
 * **`M2` — no reading of the clock here.** A secret's identity has nothing to
 * do with when it was minted, and mixing an instant in would make a derivation
 * that cannot be repeated.
 */

import { createHmac } from 'node:crypto';
import { type Mac } from '../../../shared/crypto/index.js';
import { type Random } from '../../../shared/random/index.js';
import { internal } from '../../../shared/errors/index.js';
import { unwrap } from '../../../shared/result/index.js';
import { type EndpointId } from '../domain/index.js';
import { type Secrets } from '../app/ports.js';

const SECRET_PREFIX = 'webhooks.secret.v1.';
const FINGERPRINT_PREFIX = 'webhooks.fingerprint.v1.';

/**
 * The secret as an owner sees it. `whsec_` because every receiver library
 * recognizes the shape, and a prefix in a leaked log is what makes a secret
 * scanner able to find it before somebody else does.
 */
const REVEAL_PREFIX = 'whsec_';

export interface SecretsOptions {
  readonly mac: Mac;
  readonly random: Random;
  /** How the row's fingerprint is turned back into a signing key. */
  readonly fingerprintOf: (id: EndpointId) => Promise<string | undefined>;
}

export function derivedSecrets(options: SecretsOptions): Secrets {
  const { mac, random } = options;

  const secretFor = (nonce: string): string =>
    unwrap(mac.tag(`${SECRET_PREFIX}${nonce}`));

  const fingerprintFor = (secret: string): string =>
    // **The nonce rides along in the fingerprint**, after the tag, so a row
    // holds everything needed to re-derive the signing key and nothing that
    // shortcuts to it: the tag is a MAC under a key this process holds.
    unwrap(mac.tag(`${FINGERPRINT_PREFIX}${secret}`));

  return {
    mint() {
      const nonce = random.token(16);
      const secret = secretFor(nonce);
      return Promise.resolve({
        fingerprint: `${fingerprintFor(secret)}:${nonce}`,
        reveal: `${REVEAL_PREFIX}${secret}`,
      });
    },

    async sign(endpoint, message) {
      const stored = await options.fingerprintOf(endpoint);
      if (stored === undefined) {
        throw internal(`no signing secret for endpoint ${endpoint}`);
      }

      const nonce = stored.slice(stored.lastIndexOf(':') + 1);
      const secret = secretFor(nonce);

      // **Keyed by the secret the owner was shown**, base64 — which is what
      // makes `hmac(their_secret, id.timestamp.body)` on their side equal to
      // this on ours. `sign` is what a receiver reimplements, so it uses the
      // one primitive every language ships rather than this repository's
      // keyring format.
      return createHmac('sha256', `${REVEAL_PREFIX}${secret}`)
        .update(message, 'utf8')
        .digest('base64');
    },
  };
}
