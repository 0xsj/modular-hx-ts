/**
 * The hasher, against the **collection's** fixture.
 *
 * `../../../../conformance/fixtures/vectors/password-hash.json` — collection
 * decision 0011. Read in place rather than copied, the same way the
 * canonical-JSON and cohort vectors are: a copy is a fixture that agrees with
 * itself.
 *
 * **Four of its five cases must fail**, and each catches a shortcut a real
 * implementation ships. Two of them the library accepts on its own — checked
 * below, because that is the whole reason the fixture exists.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verify as rawVerify } from '@node-rs/argon2';
import { describe, expect, it } from 'vitest';
import { systemRandom } from '../../../shared/random/index.js';
import { Password, passwordHash } from '../domain/index.js';
import { POLICY, argon2Hasher } from './hasher.js';

interface Fixture {
  readonly parameters: {
    readonly type: string;
    readonly memory_kib: number;
    readonly iterations: number;
    readonly parallelism: number;
  };
  readonly cases: readonly {
    readonly id: string;
    readonly password: string;
    readonly phc: string;
    readonly expect: 'verify' | 'reject' | 'reject-or-rehash';
  }[];
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../../conformance/fixtures/vectors/password-hash.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as Fixture;

const hasher = argon2Hasher(systemRandom());
const at = (id: string) => {
  const found = fixture.cases.find((one) => one.id === id);
  if (found === undefined) throw new Error(`no fixture case ${id}`);
  return found;
};

describe('the parameters are the collection`s, not this repository`s', () => {
  it('matches the fixture, so a sibling cannot ship a weaker cost', () => {
    expect(POLICY.memoryCost).toBe(fixture.parameters.memory_kib);
    expect(POLICY.timeCost).toBe(fixture.parameters.iterations);
    expect(POLICY.parallelism).toBe(fixture.parameters.parallelism);
    expect(fixture.parameters.type).toBe('argon2id');
  });
});

describe('the collection fixture', () => {
  it('verifies the known-good string — CONFORMANCE §3', async () => {
    const one = at('verifies');

    expect(
      await hasher.verify(passwordHash(one.phc), Password.of(one.password)),
    ).toBe(true);
  });

  it('rejects a one-capital-letter password', async () => {
    // A verifier that trims or normalizes case passes this and must not.
    const one = at('wrong-password');

    expect(
      await hasher.verify(passwordHash(one.phc), Password.of(one.password)),
    ).toBe(false);
  });

  it('rejects a tampered tag', async () => {
    const one = at('tampered-tag');

    expect(
      await hasher.verify(passwordHash(one.phc), Password.of(one.password)),
    ).toBe(false);
  });

  it('does not SILENTLY accept a downgraded cost factor', async () => {
    // **The tag is correct at `m=8,t=1`**, so the library verifies it happily —
    // asserted below. What must not happen is nobody noticing, and
    // verify-then-rehash is the accepted upgrade path (decision 0011).
    const one = at('downgraded-cost');
    const stored = passwordHash(one.phc);

    const verified = await hasher.verify(stored, Password.of(one.password));
    const rehash = hasher.needsRehash(stored);

    // `reject-or-rehash`: either answer satisfies the case, and **silence does
    // not**. This implementation verifies and flags.
    expect(verified && rehash).toBe(true);
  });

  it('rejects argon2i where argon2id was required', async () => {
    // **The tag is correct for argon2i**, so a verifier dispatching on the
    // prefix without checking it accepts this. Hard reject, not a rehash: the
    // stored value is not the thing the policy asked for.
    const one = at('wrong-algorithm');

    expect(
      await hasher.verify(passwordHash(one.phc), Password.of(one.password)),
    ).toBe(false);
  });
});

describe('what the library does on its own, and why the fixture exists', () => {
  it('accepts BOTH shortcuts unaided', async () => {
    // Not a test of `@node-rs/argon2` — a statement of what this file adds. The
    // library is right to use the parameters in the string; a login is wrong to
    // let it, and these two lines are the requirement that was *stated and
    // unenforced* until the fixture landed.
    const weak = at('downgraded-cost');
    const wrongAlgorithm = at('wrong-algorithm');

    expect(await rawVerify(weak.phc, weak.password)).toBe(true);
    expect(await rawVerify(wrongAlgorithm.phc, wrongAlgorithm.password)).toBe(
      true,
    );
  });
});

describe('hashing', () => {
  it('produces a PHC string at policy', async () => {
    const stored = await hasher.hash(Password.of('correct horse battery'));

    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hasher.needsRehash(stored)).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Which is why the fixture pins **verification** and never a digest.
    const password = Password.of('correct horse battery');

    expect(await hasher.hash(password)).not.toBe(await hasher.hash(password));
  });

  it('round-trips its own output', async () => {
    const password = Password.of('correct horse battery');
    const stored = await hasher.hash(password);

    expect(await hasher.verify(stored, password)).toBe(true);
    expect(await hasher.verify(stored, Password.of('something else!!'))).toBe(
      false,
    );
  });

  it('refuses a hash it cannot read rather than answering false', async () => {
    // A corrupt row is not a wrong password. Answering `false` would lock a
    // user out with no signal anywhere.
    await expect(
      hasher.verify(passwordHash('not a phc string'), Password.of('whatever!')),
    ).rejects.toThrow();
  });

  it('flags an unreadable hash for rehashing rather than trusting it', () => {
    expect(hasher.needsRehash(passwordHash('not a phc string'))).toBe(true);
  });
});

describe('the dummy is a real hash at policy — case 7', () => {
  it('is argon2id at the configured cost, so verifying costs what a real one does', () => {
    expect(hasher.dummy).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hasher.needsRehash(hasher.dummy)).toBe(false);
  });

  it('never verifies', async () => {
    // It protects nothing and its only job is to cost the same.
    expect(
      await hasher.verify(hasher.dummy, Password.of('correct horse battery')),
    ).toBe(false);
  });
});
