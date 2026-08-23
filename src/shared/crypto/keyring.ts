/**
 * The keyring. **L3 capability, and the module.**
 *
 * The primitives are library calls. What this module owns is the answer to
 * *which key produced this, and how do I rotate without invalidating history.*
 *
 * **A ring per purpose, never one key for everything.** Signing, encryption and
 * MAC are separate purposes with separate rings — compromising one must not
 * compromise the others, and they rotate on different schedules.
 *
 * **One current key, any number of retired ones.** New artefacts use current;
 * verification and decryption try current, then retired. **Rotation is adding a
 * key, never invalidating old ones** — an artefact signed last year must still
 * verify today, or the whole provenance story collapses.
 *
 * See `notes/patterns/crypto.md`.
 */

import { Buffer } from 'node:buffer';
import { invalid, internal, notFound } from '../errors/index.js';
import { type Random } from '../random/index.js';
import { err, ok, type Result } from '../result/index.js';

/**
 * Separate rings, separate compromise.
 *
 * It looks like ceremony at three rings, and it is the reason a compromised MAC
 * key does not become a compromised signing key.
 */
export const Purpose = {
  /** Ed25519. Signatures others verify with an exported public key. */
  Signing: 'signing',
  /** AES-256-GCM. Field encryption. */
  Encryption: 'encryption',
  /** HMAC-SHA256. Challenge tokens, session fingerprints. */
  Mac: 'mac',
} as const;

export type Purpose = (typeof Purpose)[keyof typeof Purpose];

export const PURPOSES: readonly Purpose[] = [
  Purpose.Signing,
  Purpose.Encryption,
  Purpose.Mac,
];

/** `k1`, `2026-08`, `enc-3`. Short, and it reaches every artefact. */
const KEY_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface Key {
  readonly id: string;
  /**
   * The bytes.
   *
   * **Never printed, anywhere.** Not in an error, not truncated, not in a debug
   * log. The `id` is loggable; this is not. `toJSON` is defined on the ring to
   * make an accidental `JSON.stringify` produce ids rather than material.
   */
  readonly material: Uint8Array;
}

export interface Ring {
  readonly purpose: Purpose;
  /** What new artefacts are produced with. */
  current(): Key;
  /** Current or retired, by id. What verification and decryption use. */
  byId(id: string): Result<Key>;
  /** Every id, current first. For `doctor` and for a key-usage audit. */
  ids(): readonly string[];
  /** Whether this ring was generated at boot. See `ephemeralRing`. */
  readonly ephemeral: boolean;
}

export interface Keyring {
  ring(purpose: Purpose): Result<Ring>;
  /** Purposes this process has keys for. */
  purposes(): readonly Purpose[];
  /** True when **any** ring was generated at boot. */
  readonly ephemeral: boolean;
}

/** The JSON a `CRYPTO_KEYS` reference resolves to. */
export interface RingSpec {
  readonly current: string;
  /** `id -> base64 material`. */
  readonly keys: Readonly<Record<string, string>>;
}

export type KeysetSpec = Readonly<Record<string, RingSpec>>;

const SIZES: Readonly<Record<Purpose, number>> = {
  // AES-256.
  [Purpose.Encryption]: 32,
  // HMAC-SHA256's block-sized key. Shorter is legal and weaker.
  [Purpose.Mac]: 32,
  // An Ed25519 seed, from which the key pair is derived deterministically —
  // so the same seed produces the same public key in every language.
  [Purpose.Signing]: 32,
};

function makeRing(
  purpose: Purpose,
  keys: readonly Key[],
  currentId: string,
  ephemeral: boolean,
): Result<Ring> {
  const byId = new Map(keys.map((k) => [k.id, k]));
  const current = byId.get(currentId);

  if (current === undefined) {
    return err(
      invalid(`${purpose}: current key "${currentId}" is not in the ring`),
    );
  }

  const ring: Ring = {
    purpose,
    ephemeral,
    current: () => current,
    byId(id) {
      const key = byId.get(id);
      // **A clean failure, never a throw.** An unknown key id arrives from
      // stored data — a row written by a deploy whose key has since been
      // removed — and that is an operational problem to report, not a crash.
      return key === undefined
        ? err(notFound(`${purpose}: no key "${id}" in the ring`))
        : ok(key);
    },
    ids: () => [
      currentId,
      ...keys.map((k) => k.id).filter((i) => i !== currentId),
    ],
  };

  // An accidental `JSON.stringify(ring)` prints ids, never material.
  Object.defineProperty(ring, 'toJSON', {
    value: () => ({ purpose, current: currentId, ids: ring.ids(), ephemeral }),
    enumerable: false,
  });

  return ok(ring);
}

/**
 * Build a keyring from a parsed keyset.
 *
 * Every problem at once, like `env` — a deploy fixing one key per restart is
 * the same waste here as there.
 */
export function keyring(spec: KeysetSpec): Result<Keyring> {
  const rings = new Map<Purpose, Ring>();
  const problems: string[] = [];

  for (const [name, entry] of Object.entries(spec)) {
    if (!PURPOSES.includes(name as Purpose)) {
      problems.push(`${name}: not a purpose (${PURPOSES.join(', ')})`);
      continue;
    }
    const purpose = name as Purpose;
    const keys: Key[] = [];

    for (const [id, encoded] of Object.entries(entry.keys)) {
      if (!KEY_ID.test(id)) {
        problems.push(`${purpose}.${id}: not a usable key id`);
        continue;
      }

      let material: Buffer;
      try {
        material = Buffer.from(encoded, 'base64');
      } catch {
        problems.push(`${purpose}.${id}: material is not base64`);
        continue;
      }

      if (material.byteLength !== SIZES[purpose]) {
        // The length, never the bytes.
        problems.push(
          `${purpose}.${id}: material is ${String(material.byteLength)} bytes, expected ${String(SIZES[purpose])}`,
        );
        continue;
      }
      keys.push({ id, material: new Uint8Array(material) });
    }

    const built = makeRing(purpose, keys, entry.current, false);
    if (!built.ok) {
      problems.push(built.error.message);
      continue;
    }
    rings.set(purpose, built.value);
  }

  if (problems.length > 0) {
    return err(
      invalid(
        `${String(problems.length)} keyset problem(s): ${problems.join('; ')}`,
      ),
    );
  }

  return ok(assemble(rings, false));
}

/** Parse the JSON a `CRYPTO_KEYS` reference resolves to, then build. */
export function parseKeyring(json: string): Result<Keyring> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Never the input: it is key material.
    return err(invalid('CRYPTO_KEYS is not valid JSON'));
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err(invalid('CRYPTO_KEYS is not an object'));
  }
  return keyring(parsed as KeysetSpec);
}

/**
 * A keyring generated at boot. **Development only, and it warns.**
 *
 * This is what lets `STORAGE=memory` run with nothing installed — invariant
 * `I1` again. It also means **everything encrypted is lost on restart**, and
 * nothing signed by it verifies afterwards.
 *
 * The composition root says so at startup rather than letting somebody discover
 * it in staging, and `ephemeral` is on the ring so `doctor` and `health` can
 * report it too.
 */
export function ephemeralKeyring(random: Random): Keyring {
  const rings = new Map<Purpose, Ring>();

  for (const purpose of PURPOSES) {
    const key: Key = { id: 'dev', material: random.bytes(SIZES[purpose]) };
    const built = makeRing(purpose, [key], 'dev', true);
    if (!built.ok) throw internal('the ephemeral keyring could not be built');
    rings.set(purpose, built.value);
  }

  return assemble(rings, true);
}

function assemble(rings: Map<Purpose, Ring>, ephemeral: boolean): Keyring {
  return {
    ephemeral,
    ring(purpose) {
      const found = rings.get(purpose);
      return found === undefined
        ? err(invalid(`no ${purpose} keys are configured`))
        : ok(found);
    },
    purposes: () => [...rings.keys()],
  };
}
