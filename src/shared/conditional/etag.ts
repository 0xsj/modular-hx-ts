/**
 * Entity tags. **L4 edge, and fixed by RFC 9110 rather than by us.**
 *
 * The grammar (§8.8.3) and the two comparison functions (§8.8.3.2) are the part
 * of `conditional` that depends on no decision this codebase has yet made,
 * which is why it ships before any aggregate exists to produce one. The same
 * line the collection drew for the canonical-JSON fixtures.
 *
 * See `notes/patterns/conditional.md`.
 */

import { canonicalBytes, digestOfBytes } from '../digest/index.js';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/**
 * One entity tag.
 *
 * `opaque` is the value **without** quotes: comparison is over the opaque-tag,
 * and keeping the quotes in the field would mean every comparison had to
 * remember to strip them.
 */
export interface ETag {
  readonly opaque: string;
  readonly weak: boolean;
}

/**
 * `etagc = %x21 / %x23-7E / obs-text` — RFC 9110 §8.8.3.
 *
 * Everything printable except the double quote, plus obs-text. Control
 * characters are excluded, which is what stops a tag from carrying a header
 * separator or a newline into a response.
 */
const ETAGC = /^[\x21\x23-\x7e\x80-\xff]*$/;

export function isValidOpaque(value: string): boolean {
  return ETAGC.test(value);
}

/** `"abc"` or `W/"abc"`. The quotes are part of the field, not of the tag. */
export function formatETag(tag: ETag): string {
  return `${tag.weak ? 'W/' : ''}"${tag.opaque}"`;
}

export function strongETag(opaque: string): ETag {
  return { opaque, weak: false };
}

export function weakETag(opaque: string): ETag {
  return { opaque, weak: true };
}

/**
 * Parse one entity tag.
 *
 * **`W/` is case-sensitive** — the ABNF is `%s"W/"`, a case-sensitive string
 * literal. `w/"x"` is not a weak tag; it is not a tag at all, and treating it
 * as one would silently change which comparison applies.
 */
export function parseETag(field: string): Result<ETag> {
  const raw = field.trim();
  const weak = raw.startsWith('W/');
  const quoted = weak ? raw.slice(2) : raw;

  if (quoted.length < 2 || !quoted.startsWith('"') || !quoted.endsWith('"')) {
    return err(invalid(`not an entity tag: ${field}`));
  }

  const opaque = quoted.slice(1, -1);
  if (!isValidOpaque(opaque)) {
    return err(invalid(`not an entity tag: ${field}`));
  }

  return ok({ opaque, weak });
}

/** `If-Match: *` and `If-None-Match: *`. */
export const WILDCARD = '*';

export type TagList =
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'tags'; readonly tags: readonly ETag[] };

/**
 * Parse a comma-separated list, or the wildcard.
 *
 * **Not `split(',')`.** A comma is `%x2C`, which is inside `%x23-7E`, so a
 * comma is legal *inside* an opaque-tag: `"a,b"` is one tag, not two. Naive
 * splitting turns it into two malformed entries and rejects the whole header,
 * which on `If-Match` is a 412 for a caller who did nothing wrong.
 *
 * So the scan tracks whether it is inside quotes. The tags this repository
 * emits are hex digests and contain no commas, which is exactly why this would
 * never have surfaced here — the bug only shows against a **foreign** tag, from
 * a client that got its ETag from somewhere else.
 */
export function parseTagList(field: string): Result<TagList> {
  const raw = field.trim();
  if (raw === WILDCARD) return ok({ kind: 'wildcard' });
  if (raw === '') return err(invalid('an entity tag list may not be empty'));

  const entries: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const character of raw) {
    if (character === '"') {
      inQuotes = !inQuotes;
      current += character;
      continue;
    }
    if (character === ',' && !inQuotes) {
      entries.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  entries.push(current);

  if (inQuotes) return err(invalid(`unterminated entity tag: ${field}`));

  const tags: ETag[] = [];
  for (const entry of entries) {
    if (entry.trim() === '') continue;
    const tag = parseETag(entry);
    if (!tag.ok) return err(tag.error);
    tags.push(tag.value);
  }

  if (tags.length === 0) {
    return err(invalid('an entity tag list may not be empty'));
  }
  return ok({ kind: 'tags', tags });
}

// --- the two comparisons ---------------------------------------------------
//
// **They are not interchangeable, and implementing one is the common error.**
// It passes casual testing because the two agree whenever no weak tag is
// involved, which is most of the time and never when it matters.

/**
 * **Strong comparison** — RFC 9110 §8.8.3.2. Used by `If-Match`.
 *
 * Both tags must be strong *and* octet-equal. A weak tag never matches under
 * this, not even against itself: `W/"1"` and `W/"1"` may describe two
 * representations that are semantically equivalent and byte-different, which is
 * exactly what a weak tag means, and `If-Match` guards a write.
 */
export function strongEquals(a: ETag, b: ETag): boolean {
  return !a.weak && !b.weak && a.opaque === b.opaque;
}

/**
 * **Weak comparison** — RFC 9110 §8.8.3.2. Used by `If-None-Match`.
 *
 * Octet-equal opaque tags, whatever their weakness. `If-None-Match` asks *do I
 * already have this*, and semantic equivalence is a good enough answer to that:
 * the worst case is a cache revalidation that returns 304 for a representation
 * that differs in whitespace.
 */
export function weakEquals(a: ETag, b: ETag): boolean {
  return a.opaque === b.opaque;
}

// --- deriving one ----------------------------------------------------------

/**
 * A **strong** tag over a canonical serialization.
 *
 * **Strong is forced, not chosen.** `If-Match` uses strong comparison, and a
 * weak validator never matches under it — so a `W/"v42"` tag makes conformance
 * case 29 return 412 *permanently*, passing the case for the wrong reason.
 * Nothing would ever surface that, which is worse than failing outright.
 *
 * Strong means byte-identical representations share one validator, so the tag
 * has to come from a canonical serialization. **This repository already has
 * one** — RFC 8785 canonicalization and `sha256:` identities, built for event
 * digests and cross-language parity — so a strong ETag is available here where
 * most codebases can only manage a weak one. That was not planned.
 *
 * **The variant is part of the tag**, because a tag identifies a
 * *representation* and not an entity: the same resource as JSON and as CSV must
 * not share one. A caller with the JSON in cache would otherwise be told 304
 * for the CSV.
 */
export function strongTagFor(variant: string, value: unknown): Result<ETag> {
  const bytes = canonicalBytes(value);
  if (!bytes.ok) return err(bytes.error);
  return ok(strongTagForBytes(variant, bytes.value));
}

/**
 * The same, for a serialization that is not JSON.
 *
 * A CSV or a PDF has no canonical *form* to compute — it is already bytes, and
 * those bytes are the representation. Mirrors `digest`/`digestOfBytes`.
 */
export function strongTagForBytes(variant: string, bytes: Uint8Array): ETag {
  // U+001F between the variant and the bytes -- the separator this repository
  // already uses in `flags/cohort.ts` and `idempotency/key.ts`, and for the
  // same reason: it cannot occur in a media type, so the join is unambiguous
  // by construction. Without one, variant `ab` over bytes `c` and variant `a`
  // over bytes `bc` produce the same tag.
  const prefix = new TextEncoder().encode(`${variant}${SEPARATOR}`);
  const joined = new Uint8Array(prefix.length + bytes.length);
  joined.set(prefix);
  joined.set(bytes, prefix.length);

  // `sha256:<hex>` is 71 characters and every one is legal in an opaque-tag.
  // Kept whole rather than truncated: a shortened digest is a validator with a
  // birthday bound nobody wrote down.
  return strongETag(digestOfBytes(joined));
}

/**
 * ASCII unit separator, U+001F.
 *
 * Written as an escape rather than a literal byte. A raw control character
 * makes the file binary to every text tool -- `grep` skips it silently, which
 * this repository has now paid for four times, once in this very file.
 */
const SEPARATOR = '\u001f';
