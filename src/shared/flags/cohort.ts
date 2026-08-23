/**
 * Sticky percentage cohorts. **L3 capability, and the cross-language one.**
 *
 * **A 10% rollout must mean the same 10% in every blueprint.** This is the one
 * function in the collection where all of them must agree *numerically*: if Go
 * and TypeScript disagree, the same user is inside the cohort in one and
 * outside it in another, and the resulting bug report makes no sense.
 *
 * The form is **collection decision 0009**, and it is not this repository's to
 * revise:
 *
 * ```
 * bucket(key, subject) = be_uint32( sha256(key + U+001F + subject)[0..4) ) % 10000
 * ```
 *
 * - **U+001F, not `":"`.** It cannot occur in a flag key or a subject, so the
 *   concatenation is unambiguous **by construction** — which is why there is no
 *   rejection rule here to find. A `":"` separator needed one, and
 *   `provenance.Actor.String()` is `"kind:id"`, so the most natural call site —
 *   the acting user — was rejected on every request while `flags` failed
 *   closed and the flag silently never evaluated for anybody.
 * - **The key first**, so one subject lands in a different bucket per flag
 *   rather than becoming a permanent unlucky decile in every experiment at once.
 * - **uint32 from the first four bytes**, big-endian. Exact in JavaScript, where
 *   a uint64 would need `BigInt`. The modulo bias from folding 2^32 into 10^4 is
 *   under 2^-18 per bucket, below sampling noise at any population.
 * - **Nothing counts characters.** `'😀'.length` is 2 in TypeScript and 1 in
 *   Python and Go, so any length prefix would disagree on the astral case. The
 *   string is encoded as UTF-8 bytes and hashed; no count reaches the encoding.
 *
 * **The separator is the one value here that can never be revised.** Changing it
 * after a rollout is live reassigns every bucket, so the 10% cohort becomes a
 * *different* 10% mid-experiment.
 *
 * See `notes/patterns/flags.md`.
 */

import { digestOfBytes } from '../digest/index.js';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/** Basis points. A bucket is in `[0, 10000)`. */
export const BUCKETS = 10_000;

/**
 * ASCII **unit separator**, U+001F.
 *
 * Written as an escape rather than a literal byte — a raw control character in
 * a source file makes the file binary to every text tool, which this repository
 * has paid for three times.
 */
export const SEPARATOR = '\u001f';

/**
 * Which bucket `subject` falls in for `key`.
 *
 * Deterministic, stateless, and identical in every language implementing
 * decision 0009. Total: there is no input it refuses.
 */
export function bucketOf(key: string, subject: string): number {
  const digest = digestOfBytes(
    new TextEncoder().encode(`${key}${SEPARATOR}${subject}`),
  );
  // `sha256:` then 64 hex characters; the first 8 are the first 4 bytes.
  const prefix = digest.slice('sha256:'.length, 'sha256:'.length + 8);

  return Number.parseInt(prefix, 16) % BUCKETS;
}

/**
 * Is `subject` inside a `percentage` rollout of `key`?
 *
 * **The boundaries are where modulus bugs live**, so they are decided *without
 * hashing*: 0 excludes everybody and 100 includes everybody, and no rounding can
 * put somebody the wrong side of either.
 */
export function inCohort(
  key: string,
  subject: string,
  percentage: number,
): Result<boolean> {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    return err(invalid(`a percentage is 0-100, not ${String(percentage)}`));
  }
  if (percentage === 0) return ok(false);
  if (percentage === 100) return ok(true);

  // `<`, not `<=`: with buckets `[0, 10000)` and a threshold of
  // `percentage * 100`, `<` gives exactly `percentage`% of the space.
  return ok(bucketOf(key, subject) < percentage * (BUCKETS / 100));
}
