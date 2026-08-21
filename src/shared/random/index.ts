/**
 * The one CSPRNG. **L0 kernel** — pure, no I/O, no process state.
 *
 * Invariant I5: **time, randomness and identifiers are injected.** `systemRandom`
 * is the one implementation permitted to call `crypto.getRandomValues`, exactly
 * as `systemClock` is the one permitted to read the clock.
 *
 * One module, so there is one answer to "where does entropy come from" and one
 * place to review. Randomness scattered across a codebase is how `Math.random()`
 * ends up generating a password-reset token.
 *
 * See `notes/techniques/random.md`.
 */

import { timingSafeEqual } from 'node:crypto';
import { invariant } from '../assert/index.js';

/** `crypto.getRandomValues` refuses more than this in one call. */
const MAX_DRAW = 65_536;

/** The port. `id` declares the `bytes` half of this as `RandomBytes`. */
export interface Random {
  /** `count` cryptographically random bytes. */
  bytes(count: number): Uint8Array;

  /**
   * A URL-safe token. 32 bytes — 256 bits — by default, which is the size
   * below which nobody has to think about it.
   */
  token(byteLength?: number): string;

  /** A uniformly distributed integer in `[0, maxExclusive)`. */
  int(maxExclusive: number): number;
}

// --- shared behaviour ------------------------------------------------------

const base64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64url');

/**
 * Draw an unbiased integer by rejection sampling.
 *
 * The tempting one-liner is `draw % max`, and it is biased: 2^32 is not a
 * multiple of most `max`, so the low residues come up slightly more often. For
 * a dice roll nobody notices; for a shard assignment, a sampling decision or a
 * one-time code it is a real skew, and it is invisible until someone measures.
 *
 * Expected draws is under 2, and the loop terminates with probability 1.
 */
function unbiasedInt(maxExclusive: number, draw: () => number): number {
  const limit = Math.floor(0x1_0000_0000 / maxExclusive) * maxExclusive;

  for (;;) {
    const value = draw();
    if (value < limit) return value % maxExclusive;
  }
}

function readUint32(bytes: Uint8Array): number {
  return (
    ((bytes[0] ?? 0) * 2 ** 24 +
      (bytes[1] ?? 0) * 2 ** 16 +
      (bytes[2] ?? 0) * 2 ** 8 +
      (bytes[3] ?? 0)) >>>
    0
  );
}

function makeRandom(fill: (into: Uint8Array) => void): Random {
  const bytes = (count: number): Uint8Array => {
    // A bad count is a bug, not user input, so it asserts rather than
    // returning a Result nobody can act on. See notes/patterns/assert.md.
    invariant(
      Number.isInteger(count) && count >= 0,
      'byte count is a non-negative integer',
    );

    const out = new Uint8Array(count);
    // Chunked, because the platform refuses a single large draw.
    for (let offset = 0; offset < count; offset += MAX_DRAW) {
      fill(out.subarray(offset, Math.min(offset + MAX_DRAW, count)));
    }
    return out;
  };

  return {
    bytes,
    token: (byteLength = 32) => base64url(bytes(byteLength)),
    int: (maxExclusive) => {
      invariant(
        Number.isInteger(maxExclusive) && maxExclusive > 0,
        'maxExclusive is a positive integer',
      );
      return unbiasedInt(maxExclusive, () => readUint32(bytes(4)));
    },
  };
}

// --- the real one ----------------------------------------------------------

export function systemRandom(): Random {
  return makeRandom((into) => {
    crypto.getRandomValues(into);
  });
}

// --- the fake one ----------------------------------------------------------

/**
 * A deterministic stream, for tests.
 *
 * **Not random.** xorshift32 seeded by the caller: reproducible, uniform enough
 * that a distribution test means something, and utterly predictable. It exists
 * so a test can assert on an exact token, and it must never reach a code path
 * that mints one for real — which is what the `Random` port and a composition
 * root that wires `systemRandom` are for.
 */
export function fakeRandom(seed = 1): Random {
  let state = seed >>> 0 || 1;

  return makeRandom((into) => {
    for (let index = 0; index < into.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      into[index] = state & 0xff;
    }
  });
}

// --- comparison ------------------------------------------------------------

/**
 * Compare two secrets without leaking where they differ.
 *
 * `a === b` on a string stops at the first differing byte, so how long the
 * comparison took tells an attacker how much of their guess was right. Given
 * enough samples that turns forging a session token or an HMAC from a
 * 2^256 problem into a 32-step one, byte by byte.
 *
 * Delegates to `node:crypto`'s `timingSafeEqual` rather than hand-rolling the
 * loop: a hand-written accumulator is correct on paper and at the mercy of
 * whatever the JIT decides to do with it.
 *
 * **Length is not hidden.** Inputs of different lengths return `false`
 * immediately. That is the accepted trade — `timingSafeEqual` throws on a
 * length mismatch — and it is safe precisely because token lengths here are
 * fixed and public. Never use this where the length is the secret.
 */
export function constantTimeEqual(
  a: string | Uint8Array,
  b: string | Uint8Array,
): boolean {
  const left = typeof a === 'string' ? Buffer.from(a, 'utf8') : Buffer.from(a);
  const right = typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b);

  if (left.length !== right.length) return false;
  if (left.length === 0) return true;

  return timingSafeEqual(left, right);
}
