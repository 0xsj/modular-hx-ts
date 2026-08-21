import { describe, expect, it } from 'vitest';
import { isAppError, Kind } from '../errors/index.js';
import { constantTimeEqual, fakeRandom, systemRandom } from './index.js';

const thrownKind = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return isAppError(error) ? error.kind : error;
  }
  return undefined;
};

describe('bytes', () => {
  it('returns exactly the count asked for', () => {
    const random = systemRandom();

    expect(random.bytes(0)).toHaveLength(0);
    expect(random.bytes(1)).toHaveLength(1);
    expect(random.bytes(32)).toHaveLength(32);
  });

  it('draws past the platform single-call limit', () => {
    // crypto.getRandomValues refuses more than 65536 at once, so bytes() is
    // chunked. Without it a large token would throw, and only in production.
    const bytes = systemRandom().bytes(200_000);

    expect(bytes).toHaveLength(200_000);
    // Every chunk was actually filled: an unfilled tail would be all zeroes.
    expect(bytes.subarray(150_000).some((byte) => byte !== 0)).toBe(true);
  });

  it('treats a bad count as a bug, not as input', () => {
    const random = systemRandom();

    expect(thrownKind(() => random.bytes(-1))).toBe(Kind.Internal);
    expect(thrownKind(() => random.bytes(1.5))).toBe(Kind.Internal);
    expect(thrownKind(() => random.bytes(Number.NaN))).toBe(Kind.Internal);
  });

  it('does not repeat itself', () => {
    const random = systemRandom();
    const draws = new Set(Array.from({ length: 100 }, () => random.token(16)));

    expect(draws.size).toBe(100);
  });
});

describe('token', () => {
  it('defaults to 256 bits', () => {
    // 32 bytes in base64url is 43 characters, unpadded.
    expect(systemRandom().token()).toHaveLength(43);
  });

  it('is URL-safe and unpadded', () => {
    // A token that needs escaping ends up in a query string escaped
    // inconsistently, and then compared against the unescaped original.
    for (let attempt = 0; attempt < 50; attempt++) {
      expect(systemRandom().token()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('takes a byte length', () => {
    expect(systemRandom().token(16)).toHaveLength(22);
    expect(systemRandom().token(64)).toHaveLength(86);
  });
});

describe('int', () => {
  it('stays inside the range', () => {
    const random = fakeRandom(7);

    for (let draw = 0; draw < 2_000; draw++) {
      const value = random.int(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it('always returns 0 for a bound of 1', () => {
    expect(fakeRandom().int(1)).toBe(0);
  });

  it('is close to uniform', () => {
    // Rejection sampling rather than `draw % max`. The modulo version skews
    // toward low residues because 2^32 is not a multiple of 6; the skew is
    // small, real, and invisible until somebody measures it — so this measures.
    const random = fakeRandom(1234);
    const buckets = new Array<number>(6).fill(0);
    const draws = 60_000;

    for (let draw = 0; draw < draws; draw++) {
      const bucket = random.int(6);
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }

    expect(buckets.reduce((sum, count) => sum + count, 0)).toBe(draws);

    const expected = draws / 6;
    for (const count of buckets) {
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.1);
    }
  });

  it('treats a bad bound as a bug', () => {
    const random = systemRandom();

    expect(thrownKind(() => random.int(0))).toBe(Kind.Internal);
    expect(thrownKind(() => random.int(-5))).toBe(Kind.Internal);
    expect(thrownKind(() => random.int(2.5))).toBe(Kind.Internal);
  });
});

describe('fakeRandom', () => {
  it('repeats exactly for the same seed', () => {
    expect(fakeRandom(42).token()).toBe(fakeRandom(42).token());
    expect(fakeRandom(42).bytes(16)).toEqual(fakeRandom(42).bytes(16));
  });

  it('differs between seeds', () => {
    expect(fakeRandom(1).token()).not.toBe(fakeRandom(2).token());
  });

  it('produces tokens the same shape as the real thing', () => {
    // A fake whose output does not look like production output hides bugs.
    expect(fakeRandom().token()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('uses the whole byte range', () => {
    const seen = new Set(fakeRandom(9).bytes(20_000));

    expect(seen.size).toBeGreaterThan(250);
  });
});

describe('constantTimeEqual', () => {
  const token = 'k3Yq7Zt1XwPv9RsL2mNb8FhJ4dCgA6eU';

  it('agrees with === on what is equal', () => {
    const cases: [string, string][] = [
      [token, token],
      ['', ''],
      ['a', 'a'],
      ['ada@example.com', 'ada@example.com'],
      ['naïve café 🔐', 'naïve café 🔐'],
    ];

    for (const [a, b] of cases) {
      expect(constantTimeEqual(a, b)).toBe(a === b);
      expect(constantTimeEqual(a, b)).toBe(true);
    }
  });

  it('agrees with === on what is not', () => {
    const cases: [string, string][] = [
      [token, `${token.slice(0, -1)}X`], // differs in the last byte only
      [token, `X${token.slice(1)}`], // differs in the first byte only
      ['a', 'b'],
      ['ada@example.com', 'ada@example.org'],
      ['naïve café 🔐', 'naive cafe 🔐'],
    ];

    for (const [a, b] of cases) {
      expect(constantTimeEqual(a, b)).toBe(a === b);
      expect(constantTimeEqual(a, b)).toBe(false);
    }
  });

  it('returns false for different lengths rather than throwing', () => {
    // timingSafeEqual throws on a length mismatch; a comparison that throws is
    // a comparison somebody wraps in a try and gets wrong.
    expect(constantTimeEqual(token, token.slice(0, 8))).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
  });

  it('compares bytes, and bytes against strings', () => {
    const encoder = new TextEncoder();

    expect(
      constantTimeEqual(encoder.encode(token), encoder.encode(token)),
    ).toBe(true);
    expect(constantTimeEqual(encoder.encode(token), token)).toBe(true);
    expect(constantTimeEqual(encoder.encode(token), 'nope')).toBe(false);
  });

  it('compares multibyte text by bytes, not by code units', () => {
    // Two different strings that share a prefix in UTF-8.
    expect(constantTimeEqual('café', 'cafe')).toBe(false);
    expect(constantTimeEqual('🔐', '🔐')).toBe(true);
  });
});
