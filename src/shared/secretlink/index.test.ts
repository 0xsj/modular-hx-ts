/**
 * `secretlink`. **The wire half of an out-of-band secret.**
 *
 * The cases that matter are the two the module exists for: a forged identifier
 * is refused **before** any lookup, and the store holds nothing presentable.
 */

import { describe, expect, it } from 'vitest';
import { ephemeralKeyring, keyring, makeMac } from '../crypto/index.js';
import { systemRandom } from '../random/index.js';
import { fingerprintOf } from '../token/index.js';
import { unwrap } from '../result/index.js';
import { authentic, issue, matches, parse, readable } from './index.js';

const random = systemRandom();
const mac = makeMac(ephemeralKeyring(random));
const other = makeMac(ephemeralKeyring(random));

const link = (id = 'row-1') => unwrap(issue({ id, random, mac }));

describe('issuing', () => {
  it('returns a token carrying the id, the secret and a tag', () => {
    const issued = link();

    const parts = parse(issued.token);
    expect(parts?.id).toBe('row-1');
    expect(parts?.secret).not.toBe('');
    expect(parts?.tag).not.toBe('');
  });

  it('gives back a fingerprint and NOT the secret', () => {
    // **The store never holds a usable value**, which is what makes
    // conformance case 16 true rather than aspirational: a key shown once must
    // be one that *cannot* be returned.
    const issued = link();

    expect(issued.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(issued.token).not.toContain(issued.fingerprint);
    expect(Object.values(issued)).not.toContain(
      parse(issued.token)?.secret ?? '',
    );
  });

  it('mints a different secret every time', () => {
    expect(link().token).not.toBe(link().token);
  });
});

describe('a forged identifier', () => {
  it('is refused BEFORE any lookup — the reason the MAC exists', () => {
    // Without the tag, an id on the wire is an id an attacker can forge and
    // probe against the table: one request per guess, and the answer is
    // whether the row exists. With it, the guess is refused by arithmetic.
    const issued = link('row-1');
    const parts = parse(issued.token);
    if (parts === undefined) throw new Error('unreachable');

    const forged = { ...parts, id: 'row-2' };

    expect(authentic(parts, mac)).toBe(true);
    expect(authentic(forged, mac)).toBe(false);
  });

  it('is refused when the tag came from a different keyring', () => {
    const issued = link();
    const parts = parse(issued.token);
    if (parts === undefined) throw new Error('unreachable');

    expect(authentic(parts, other)).toBe(false);
  });

  it('survives key rotation, because verification checks the whole ring', () => {
    // §4's *keyring-aware so rotation does not break outstanding links*, and it
    // is a property of `crypto` rather than of this module — asserted here
    // because this is the module whose values are still in somebody's mailbox
    // when the key changes.
    const old = 'k1';
    const fresh = 'k2';
    const material = (seed: string) =>
      Buffer.from(seed.repeat(32).slice(0, 32)).toString('base64');

    const before = unwrap(
      keyring({ mac: { current: old, keys: { [old]: material('a') } } }),
    );
    const issued = unwrap(issue({ id: 'row-1', random, mac: makeMac(before) }));
    const parts = parse(issued.token);
    if (parts === undefined) throw new Error('unreachable');

    // The signing key moved on; the old one is still in the ring.
    const after = unwrap(
      keyring({
        mac: {
          current: fresh,
          keys: { [old]: material('a'), [fresh]: material('b') },
        },
      }),
    );

    expect(authentic(parts, makeMac(after))).toBe(true);
  });
});

describe('parsing', () => {
  it('accepts a tag that contains dots, because every tag does', () => {
    // `crypto` spells a tag `v1.<kid>.<tag>`. An exact three-part split refused
    // every link this module issues, which the first read-back test caught.
    const issued = link();

    expect(parse(issued.token)?.tag).toMatch(/^v1\./);
  });

  it.each([['not-a-link'], ['only.two'], ['.b.c'], ['a..c'], ['a.b.'], ['']])(
    'refuses %s with no distinct error',
    (value) => {
      // One answer for every malformed shape: a caller must not be able to tell
      // a malformed link from an expired one, which is case 13's rule, enforced
      // here by having nothing else to return.
      expect(parse(value)).toBeUndefined();
    },
  );
});

describe('matching the secret', () => {
  it('accepts the presented secret against its own fingerprint', () => {
    const issued = link();
    const parts = parse(issued.token);
    if (parts === undefined) throw new Error('unreachable');

    expect(matches(parts, issued.fingerprint)).toBe(true);
  });

  it('refuses another link`s secret, even with a valid tag', () => {
    // The tag proves the id is ours; only the digest proves possession.
    const mine = link('row-1');
    const theirs = link('row-1');
    const parts = parse(theirs.token);
    if (parts === undefined) throw new Error('unreachable');

    expect(authentic(parts, mac)).toBe(true);
    expect(matches(parts, mine.fingerprint)).toBe(false);
  });

  it('refuses a fingerprint of the wrong thing', () => {
    const issued = link();
    const parts = parse(issued.token);
    if (parts === undefined) throw new Error('unreachable');

    expect(matches(parts, fingerprintOf('something else'))).toBe(false);
  });
});

describe('readable — parse and authenticate together', () => {
  it('returns the parts for a link we issued', () => {
    expect(readable(link().token, mac)?.id).toBe('row-1');
  });

  it('returns undefined for a forged tag and for a malformed value alike', () => {
    const issued = link();
    const tampered = `${issued.id}.${parse(issued.token)?.secret ?? ''}.forged`;

    expect(readable(tampered, mac)).toBeUndefined();
    expect(readable('nonsense', mac)).toBeUndefined();
  });
});

describe('what is deliberately absent', () => {
  it('has no clock, no TTL and no purpose', async () => {
    // **The signal named in the collection brief**: wanting a clock in here is
    // the sign that the wrong half is moving. TTL, single-use and purpose are
    // rules, and `S7` puts no shared module within reach of the aggregate that
    // owns them — so they could not travel even if they should.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./index.ts', import.meta.url), 'utf8'),
    );
    const code = source.slice(source.indexOf('import {'));

    expect(code).not.toContain('Clock');
    expect(code).not.toContain('expiresAt');
    expect(code).not.toContain('consumedAt');
  });
});
