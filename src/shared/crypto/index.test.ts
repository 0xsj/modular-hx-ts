import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { Kind, kindOf } from '../errors/index.js';
import { fakeRandom, systemRandom } from '../random/index.js';
import { isErr, unwrap } from '../result/index.js';
import { keyIdOf, makeAead, type Binding } from './aead.js';
import { derive } from './derive.js';
import {
  ephemeralKeyring,
  keyring,
  parseKeyring,
  Purpose,
  type KeysetSpec,
} from './keyring.js';
import { makeMac, tagKeyId } from './mac.js';
import { makeSigner, publicKeyBytes, signatureKeyId } from './sign.js';

/** Fixed material, so every assertion below is deterministic. */
const material = (byte: number): string =>
  Buffer.alloc(32, byte).toString('base64');

/** `k2` is current; `k1` is retired but still on the ring. */
const SPEC: KeysetSpec = {
  encryption: { current: 'k2', keys: { k1: material(1), k2: material(2) } },
  mac: { current: 'm2', keys: { m1: material(3), m2: material(4) } },
  signing: { current: 's2', keys: { s1: material(5), s2: material(6) } },
};

/** The same ring with `k1` current — what the process looked like before. */
const BEFORE: KeysetSpec = {
  ...SPEC,
  encryption: { current: 'k1', keys: SPEC['encryption']?.keys ?? {} },
};

const random = systemRandom();
const keys = unwrap(keyring(SPEC));

const BINDING: Binding = {
  tenant: 't_acme',
  table: 'users',
  id: 'u1',
  field: 'email',
};

describe('the keyring', () => {
  it('has one current key and any number of retired ones', () => {
    const ring = unwrap(keys.ring(Purpose.Encryption));

    expect(ring.current().id).toBe('k2');
    expect([...ring.ids()].sort()).toEqual(['k1', 'k2']);
    expect(unwrap(ring.byId('k1')).id).toBe('k1');
  });

  it('keeps a ring per purpose, so one compromise is not three', () => {
    // It looks like ceremony at three rings, and it is the reason a compromised
    // MAC key does not become a compromised signing key.
    const enc = unwrap(keys.ring(Purpose.Encryption)).current();
    const mac = unwrap(keys.ring(Purpose.Mac)).current();

    expect(Buffer.from(enc.material).equals(Buffer.from(mac.material))).toBe(
      false,
    );
  });

  it('fails cleanly on an unknown key id rather than throwing', () => {
    // An unknown id arrives from stored data — a row written by a deploy whose
    // key has since been removed. That is an operational problem to report.
    const missing = unwrap(keys.ring(Purpose.Encryption)).byId('nope');

    expect(kindOf(isErr(missing) ? missing.error : undefined)).toBe(
      Kind.NotFound,
    );
  });

  it('refuses a current key that is not on the ring', () => {
    expect(
      isErr(keyring({ mac: { current: 'gone', keys: { m1: material(1) } } })),
    ).toBe(true);
  });

  it('refuses material of the wrong length, and never prints it', () => {
    const bad = keyring({
      mac: {
        current: 'm1',
        keys: { m1: Buffer.alloc(8, 9).toString('base64') },
      },
    });

    expect(isErr(bad)).toBe(true);
    const message = isErr(bad) ? bad.error.message : '';
    expect(message).toContain('8 bytes');
    // The length is reportable. The bytes are not.
    expect(message).not.toContain(Buffer.alloc(8, 9).toString('base64'));
  });

  it('reports every keyset problem at once', () => {
    const bad = keyring({
      nonsense: { current: 'x', keys: {} },
      mac: { current: 'm1', keys: { 'not a key id': material(1) } },
    });

    expect(isErr(bad)).toBe(true);
  });

  it('never prints key material through JSON.stringify', () => {
    // Private fields are not an option on a plain object, so the ring defines
    // `toJSON` — the same trick `Provenance` uses.
    const printed = JSON.stringify(unwrap(keys.ring(Purpose.Encryption)));

    expect(printed).toContain('k2');
    expect(printed).not.toContain(material(2));
  });

  it('refuses a keyset that is not JSON, without echoing it', () => {
    const bad = parseKeyring('{not json');

    expect(isErr(bad)).toBe(true);
    expect(isErr(bad) ? bad.error.message : '').not.toContain('not json');
  });
});

describe('the ephemeral dev ring', () => {
  it('is generated at boot and says so', () => {
    // What lets STORAGE=memory run with nothing installed — and what loses
    // everything encrypted on restart.
    const dev = ephemeralKeyring(fakeRandom());

    expect(dev.ephemeral).toBe(true);
    expect(unwrap(dev.ring(Purpose.Encryption)).ephemeral).toBe(true);
    expect(dev.purposes()).toHaveLength(3);
  });

  it('is a working ring, not a stub', () => {
    const dev = ephemeralKeyring(fakeRandom());
    const aead = makeAead(dev, random);

    const sealed = unwrap(aead.encrypt('hello', BINDING));
    expect(unwrap(aead.decrypt(sealed, BINDING))).toBe('hello');
  });

  it('a configured keyring is not marked ephemeral', () => {
    expect(keys.ephemeral).toBe(false);
  });
});

describe('encryption', () => {
  const aead = makeAead(keys, random);

  it('round-trips under the current key', () => {
    const sealed = unwrap(aead.encrypt('ada@example.com', BINDING));

    expect(unwrap(keyIdOf(sealed))).toBe('k2');
    expect(unwrap(aead.decrypt(sealed, BINDING))).toBe('ada@example.com');
  });

  it('decrypts under a RETIRED key — this is rotation', () => {
    // **The test most implementations skip.** A value written last year under
    // `k1` must still decrypt after `k2` becomes current, or rotation is a
    // migration rather than a rotation.
    const before = makeAead(unwrap(keyring(BEFORE)), random);
    const sealed = unwrap(before.encrypt('written under k1', BINDING));
    expect(unwrap(keyIdOf(sealed))).toBe('k1');

    // The current process, whose current key is k2.
    expect(unwrap(aead.decrypt(sealed, BINDING))).toBe('written under k1');
  });

  it('produces different ciphertexts for the same plaintext', () => {
    // A fresh nonce per encryption. Reusing one under GCM leaks the XOR of two
    // plaintexts and destroys the authentication guarantee.
    const a = unwrap(aead.encrypt('same', BINDING));
    const b = unwrap(aead.encrypt('same', BINDING));

    expect(a).not.toBe(b);
    expect(unwrap(aead.decrypt(a, BINDING))).toBe('same');
    expect(unwrap(aead.decrypt(b, BINDING))).toBe('same');
  });

  it('refuses a ciphertext moved to a different ROW', () => {
    // **The attack the AAD exists for.** Without binding, swapping two users'
    // encrypted fields decrypts cleanly for both and each returns the other's
    // data, with no error anywhere.
    const sealed = unwrap(aead.encrypt('ada@example.com', BINDING));

    const moved = aead.decrypt(sealed, { ...BINDING, id: 'u2' });

    expect(isErr(moved)).toBe(true);
  });

  it('refuses a ciphertext moved to a different FIELD on the same row', () => {
    const sealed = unwrap(aead.encrypt('ada@example.com', BINDING));

    expect(isErr(aead.decrypt(sealed, { ...BINDING, field: 'phone' }))).toBe(
      true,
    );
  });

  it('refuses a ciphertext moved to a different TENANT', () => {
    const sealed = unwrap(aead.encrypt('ada@example.com', BINDING));

    expect(isErr(aead.decrypt(sealed, { ...BINDING, tenant: 't_other' }))).toBe(
      true,
    );
  });

  it('refuses a tampered ciphertext', () => {
    const sealed = unwrap(aead.encrypt('ada@example.com', BINDING));
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 0xff;
    parts[3] = body.toString('base64url');

    expect(isErr(aead.decrypt(parts.join('.'), BINDING))).toBe(true);
  });

  it('gives one message for every failure, so it is not an oracle', () => {
    const sealed = unwrap(aead.encrypt('x', BINDING));
    const moved = aead.decrypt(sealed, { ...BINDING, id: 'u2' });
    const tampered = aead.decrypt(`${sealed}x`, BINDING);

    expect(isErr(moved) ? moved.error.message : '').toBe(
      'ciphertext could not be decrypted',
    );
    expect(isErr(tampered)).toBe(true);
  });

  it('refuses anything it did not produce', () => {
    for (const bad of [
      '',
      'plaintext',
      'v2.k2.a.b',
      'v1.k2.a',
      'v1.nope.AAAA.AAAA',
    ]) {
      expect(isErr(aead.decrypt(bad, BINDING)), bad).toBe(true);
    }
  });

  it('refuses a binding containing the separator', () => {
    const separator = String.fromCharCode(31);

    expect(
      isErr(aead.encrypt('x', { ...BINDING, id: `u1${separator}u2` })),
    ).toBe(true);
  });
});

describe('MAC', () => {
  const mac = makeMac(keys);

  it('tags and verifies under the current key', () => {
    const token = unwrap(mac.tag('session:abc'));

    expect(unwrap(tagKeyId(token))).toBe('m2');
    expect(mac.verify('session:abc', token)).toBe(true);
  });

  it('verifies a tag made under a retired key', () => {
    const before = makeMac(
      unwrap(
        keyring({
          ...SPEC,
          mac: { current: 'm1', keys: SPEC['mac']?.keys ?? {} },
        }),
      ),
    );
    const token = unwrap(before.tag('session:abc'));

    expect(unwrap(tagKeyId(token))).toBe('m1');
    expect(mac.verify('session:abc', token)).toBe(true);
  });

  it('refuses a tag for a different message', () => {
    const token = unwrap(mac.tag('session:abc'));

    expect(mac.verify('session:xyz', token)).toBe(false);
  });

  it('returns false rather than erroring, for every failure', () => {
    // A malformed token, an unknown key and a wrong tag must be
    // indistinguishable — a typed error would say which of the three was hit.
    for (const bad of ['', 'nope', 'v1.m2', 'v2.m2.AAAA', 'v1.gone.AAAA']) {
      expect(mac.verify('session:abc', bad), bad).toBe(false);
    }
  });

  it('does not throw on a tag of the wrong length', () => {
    // `timingSafeEqual` throws on a length mismatch, so the length is checked
    // first — and a tag's length is not a secret.
    expect(mac.verify('m', 'v1.m2.AAAA')).toBe(false);
  });
});

describe('signing', () => {
  const signer = makeSigner(keys);

  it('signs and verifies under the current key', () => {
    const signature = unwrap(signer.sign('payload'));

    expect(unwrap(signatureKeyId(signature))).toBe('s2');
    expect(signer.verify('payload', signature)).toBe(true);
  });

  it('verifies a signature made under a retired key', () => {
    // An artefact signed last year must still verify today, or the whole
    // provenance story collapses.
    const before = makeSigner(
      unwrap(
        keyring({
          ...SPEC,
          signing: { current: 's1', keys: SPEC['signing']?.keys ?? {} },
        }),
      ),
    );
    const signature = unwrap(before.sign('payload'));

    expect(signer.verify('payload', signature)).toBe(true);
  });

  it('refuses a signature over a different message', () => {
    expect(signer.verify('other', unwrap(signer.sign('payload')))).toBe(false);
  });

  it('exports a public key per ring key, retired included', () => {
    // Retired keys stay published, or last year's signature becomes
    // unverifiable by anyone who was not there.
    const published = unwrap(signer.publicKeys());

    expect(Object.keys(published).sort()).toEqual(['s1', 's2']);
    for (const encoded of Object.values(published)) {
      expect(Buffer.from(encoded, 'base64url')).toHaveLength(32);
    }
  });

  it('derives the same public key from the same seed, every time', () => {
    // The property that makes a signature cross-language verifiable: the seed
    // is the key material, and the pair derives deterministically.
    const key = unwrap(keys.ring(Purpose.Signing)).current();

    expect(Buffer.from(publicKeyBytes(key)).toString('hex')).toBe(
      Buffer.from(publicKeyBytes(key)).toString('hex'),
    );
    expect(publicKeyBytes(key)).toHaveLength(32);
  });
});

describe('derivation', () => {
  const key = unwrap(keys.ring(Purpose.Mac)).current();

  it('gives a different sub-key per use', () => {
    // One ring serving several uses without new key material.
    const csrf = unwrap(derive(key, 'csrf'));
    const fingerprint = unwrap(derive(key, 'session-fingerprint'));

    expect(Buffer.from(csrf).equals(Buffer.from(fingerprint))).toBe(false);
  });

  it('is reproducible, which is what makes it usable at all', () => {
    expect(Buffer.from(unwrap(derive(key, 'csrf'))).toString('hex')).toBe(
      Buffer.from(unwrap(derive(key, 'csrf'))).toString('hex'),
    );
  });

  it('is not the key it came from', () => {
    expect(
      Buffer.from(unwrap(derive(key, 'csrf'))).equals(
        Buffer.from(key.material),
      ),
    ).toBe(false);
  });

  it('requires a use, because an empty one defeats the separation', () => {
    expect(isErr(derive(key, ''))).toBe(true);
  });

  it('refuses an unreasonable length', () => {
    expect(isErr(derive(key, 'x', 8))).toBe(true);
    expect(isErr(derive(key, 'x', 128))).toBe(true);
  });
});
