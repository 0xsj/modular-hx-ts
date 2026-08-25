/**
 * The password hasher. **`identity` infra — a driven adapter.**
 *
 * **Argon2id, `m=19456` KiB, `t=2`, `p=1`, PHC string format** — collection
 * decision 0011, at the OWASP baseline.
 *
 * This file previously shipped scrypt, and the reason it did was a real one:
 * every route to Argon2id looked like a native dependency, and a supply-chain
 * decision does not belong to a login route being wired. **The objection did
 * not survive checking the package.** `@node-rs/argon2` is Rust with prebuilt
 * binaries and no node-gyp — there is no compiler at install time — and a
 * blueprint that ships the second-best KDF exports that choice to everyone who
 * clones it.
 *
 * **The domain knows none of this.** Moving to something else changes this file
 * and nothing else, and the stored format carries its own parameters so old
 * hashes keep verifying.
 *
 * See `notes/domain/identity.md`.
 */

import { hash, verify } from '@node-rs/argon2';
import { internal } from '../../../shared/errors/index.js';
import { type Random } from '../../../shared/random/index.js';
import {
  type Password,
  type PasswordHash,
  passwordHash,
} from '../domain/index.js';
import { type Hasher } from '../app/ports.js';

/**
 * The OWASP baseline, and decision 0011's numbers.
 *
 * **Recorded here and checked against every stored hash**, which is the half a
 * naive implementation skips: the library happily verifies a hash computed at
 * `m=8,t=1`, because the parameters travel *in the string* and it uses them.
 * That is correct of the library and wrong of a login, and it is why the
 * conformance fixture carries a `downgraded-cost` case whose tag is genuinely
 * valid at that cost.
 */
/**
 * `Algorithm.Argon2id` and `Version.V0x13`, as numbers.
 *
 * `@node-rs/argon2` publishes these as **ambient const enums**, which
 * `verbatimModuleSyntax` refuses to import — a const enum is erased at compile
 * time and there is nothing to import at runtime. The values are part of the
 * PHC format rather than the library's private business (RFC 9106: argon2id is
 * variant 2, and `v=19` is `0x13`), so naming them here is stating a
 * specification constant rather than reaching into an implementation.
 *
 * The round trip is asserted: a hash produced with these parses back as
 * `$argon2id$v=19$`.
 */
const ARGON2ID = 2;
const VERSION_0X13 = 1;

export const POLICY = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

const SALT_LENGTH = 16;

interface Phc {
  readonly algorithm: string;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<tag>`.
 *
 * Parsed rather than pattern-matched, because **the two things worth refusing
 * live in the parameters** and a `startsWith('$argon2id')` sees neither.
 */
function parsePhc(stored: string): Phc | undefined {
  const parts = stored.split('$');
  // ['', algorithm, v=..., m=..,t=..,p=.., salt, tag]
  if (parts.length !== 6 || parts[0] !== '') return undefined;

  const algorithm = parts[1] ?? '';
  const params = new Map(
    (parts[3] ?? '')
      .split(',')
      .map((pair) => pair.split('='))
      .filter((pair): pair is [string, string] => pair.length === 2)
      .map(([key, value]) => [key, Number(value)] as const),
  );

  const memoryCost = params.get('m');
  const timeCost = params.get('t');
  const parallelism = params.get('p');
  if (
    memoryCost === undefined ||
    timeCost === undefined ||
    parallelism === undefined ||
    ![memoryCost, timeCost, parallelism].every(Number.isSafeInteger)
  ) {
    return undefined;
  }

  return { algorithm, memoryCost, timeCost, parallelism };
}

/** At or above policy on every axis. */
function meetsPolicy(phc: Phc): boolean {
  return (
    phc.memoryCost >= POLICY.memoryCost &&
    phc.timeCost >= POLICY.timeCost &&
    phc.parallelism >= POLICY.parallelism
  );
}

/**
 * **Randomness is injected** — invariant `I5`.
 *
 * The library would draw its own salt, and letting it would mean nothing can
 * assert that two salts differ or that one is the length it claims. The one
 * place that matters is the one place nobody wants a surprise.
 */
export function argon2Hasher(random: Random): Hasher {
  const options = {
    algorithm: ARGON2ID,
    version: VERSION_0X13,
    ...POLICY,
  };

  const compute = (password: Password, salt: Buffer): Promise<string> =>
    hash(password.reveal(), { ...options, salt });

  return {
    async hash(password: Password): Promise<PasswordHash> {
      const salt = Buffer.from(random.bytes(SALT_LENGTH));
      return passwordHash(await compute(password, salt));
    },

    async verify(stored: PasswordHash, password: Password): Promise<boolean> {
      const phc = parsePhc(stored);
      // An unreadable hash is not a wrong password — it is a corrupt row or a
      // format this build cannot read, and answering `false` would lock the
      // user out with no signal anywhere.
      if (phc === undefined) {
        throw internal('a stored password hash could not be read');
      }

      // **`argon2id`, checked rather than assumed.** The library verifies an
      // `argon2i` string quite happily, because it dispatches on what the
      // string says. A verifier that only looks at the `$argon2i…` prefix
      // accepts a hash computed with the variant this policy did not choose —
      // which is the conformance fixture's `wrong-algorithm` case, and it is a
      // **reject**, not a rehash: the stored value is not the thing we asked
      // for.
      if (phc.algorithm !== 'argon2id') return false;

      // **Below policy is not a silent pass.** Verified first, so the caller
      // can upgrade a correct-but-weak hash rather than locking somebody out —
      // `needsRehash` below is the other half. What is refused is *silence*.
      return verify(stored, password.reveal());
    },

    /**
     * Is this stored hash below policy?
     *
     * **Verify-then-rehash is the accepted upgrade path** (decision 0011). A
     * caller that has just verified successfully upgrades the stored hash to
     * current parameters; a caller that ignores this has silently accepted a
     * weak hash, which is the thing the fixture refuses.
     */
    needsRehash(stored: PasswordHash): boolean {
      const phc = parsePhc(stored);
      return phc === undefined || !meetsPolicy(phc);
    },

    /**
     * **Conformance case 7's timing half.**
     *
     * A real Argon2id hash at policy, computed once at construction, so
     * verifying against it costs what verifying a real one costs. The login
     * command runs it through the same `verify`, so there is one code path and
     * no timing difference to find.
     *
     * Computed synchronously at construction rather than lazily: a lazy one
     * would make the *first* unknown-address login slower than every
     * subsequent one, which is an enumeration oracle with a warm-up.
     */
    dummy: passwordHash(
      // A fixed, unguessable value. It is not a secret — it protects nothing,
      // and its only job is to cost the same as a real hash.
      DUMMY_PHC,
    ),
  };
}

/**
 * Precomputed so construction costs nothing and every process agrees.
 *
 * Generated at `POLICY` from a password nobody holds. Verifying against it
 * always fails, which is the point — the work is what matters.
 */
const DUMMY_PHC =
  '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlkdW1teWR1bW15IQ$VciwZBezxdnw5m2R8N5TOsHS/lH6ASUSda7sNXCmF5Q';
