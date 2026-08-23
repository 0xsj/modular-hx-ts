/**
 * Precondition evaluation. **L4 edge, and RFC 9110 §13.2.2 fixes the order.**
 *
 * **The order is normative, not a preference.** A request carrying two
 * preconditions has exactly one defined outcome, and a server that evaluates
 * them in a different order gives a different answer to the same request. That
 * is the kind of divergence a client cannot work around, because it looks like
 * a race.
 *
 * See `notes/patterns/conditional.md`.
 */

import {
  type ETag,
  type TagList,
  parseTagList,
  strongEquals,
  weakEquals,
} from './etag.js';

/** The validators the origin currently holds for the target representation. */
export interface Validator {
  readonly etag: ETag;
  /**
   * Second precision, because HTTP-date has no more than that.
   *
   * Comparison truncates to seconds for the same reason — a `Last-Modified` of
   * `...:07` against an `If-Modified-Since` of `...:07` is *not modified*, and
   * comparing millisecond values would make every sub-second write look newer
   * than a header that could never express it.
   */
  readonly lastModified?: Date;
}

/**
 * The conditional headers, as received.
 *
 * Lower-cased names, matching the `Request.headers` the chain hands around.
 */
export interface Preconditions {
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
  readonly ifModifiedSince?: string;
  readonly ifUnmodifiedSince?: string;
  readonly ifRange?: string;
  readonly range?: string;
}

export type Outcome =
  /** Run the method. `rangeApplicable` answers §13.2.2 step 5. */
  | { readonly kind: 'proceed'; readonly rangeApplicable: boolean }
  /** 304. Only ever reached by a safe method. */
  | { readonly kind: 'not-modified' }
  /** 412. */
  | { readonly kind: 'precondition-failed' };

const SAFE = new Set(['GET', 'HEAD']);

/** `If-Modified-Since` applies to GET and HEAD only — §13.1.3. */
function isSafe(method: string): boolean {
  return SAFE.has(method.toUpperCase());
}

/**
 * An HTTP-date, or `undefined`.
 *
 * **An unparseable value is ignored, not an error** — §13.1.3 and §13.1.4 both
 * say a recipient MUST ignore the field if it is not a valid HTTP-date. That is
 * a real behavioural rule and not leniency: a broken proxy that mangles a date
 * must not turn every conditional GET into a 412.
 */
export function parseHttpDate(value: string): Date | undefined {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed;
}

/** Whole seconds. HTTP-date carries nothing finer. */
function atSecond(instant: Date): number {
  return Math.floor(instant.getTime() / 1_000);
}

/**
 * Does the list select the current representation?
 *
 * `*` matches whenever a representation exists at all, which is why the caller
 * passes `undefined` for a resource that does not.
 */
function selects(
  list: TagList,
  current: ETag | undefined,
  equals: (a: ETag, b: ETag) => boolean,
): boolean {
  if (current === undefined) return false;
  if (list.kind === 'wildcard') return true;
  return list.tags.some((tag) => equals(tag, current));
}

/**
 * Evaluate, in the order §13.2.2 fixes.
 *
 * `validator` is `undefined` when the target has no current representation —
 * which is what makes `If-Match: *` a *create-only* guard and `If-None-Match:
 * *` a *replace-only* one.
 */
export function evaluate(
  method: string,
  preconditions: Preconditions,
  validator: Validator | undefined,
): Outcome {
  const current = validator?.etag;
  const failed: Outcome = { kind: 'precondition-failed' };

  // 1 · If-Match, with **strong** comparison.
  if (preconditions.ifMatch !== undefined) {
    const list = parseTagList(preconditions.ifMatch);
    // A malformed `If-Match` is not ignorable the way a malformed date is: the
    // caller asked for a guard and we cannot evaluate it, so we must not write.
    if (!list.ok) return failed;
    if (!selects(list.value, current, strongEquals)) return failed;
    // True: skip step 2 entirely. `If-Unmodified-Since` is consulted **only**
    // when `If-Match` is absent — not merely when it passed.
  } else if (preconditions.ifUnmodifiedSince !== undefined) {
    // 2 · If-Unmodified-Since.
    const since = parseHttpDate(preconditions.ifUnmodifiedSince);
    if (since !== undefined) {
      const modified = validator?.lastModified;
      // No `Last-Modified` to compare means the condition cannot be satisfied.
      if (modified === undefined) return failed;
      if (atSecond(modified) > atSecond(since)) return failed;
    }
  }

  // 3 · If-None-Match, with **weak** comparison.
  if (preconditions.ifNoneMatch !== undefined) {
    const list = parseTagList(preconditions.ifNoneMatch);
    // Malformed here is treated as *no match*, which lets the request proceed:
    // the header asks to avoid redundant work, and failing to parse it costs a
    // transfer rather than a wrong write.
    if (list.ok && selects(list.value, current, weakEquals)) {
      // **304 on GET and HEAD, 412 on anything else.** The 412 branch is the
      // one reliably wrong in the wild, because a browser never exercises it:
      // a failed `If-None-Match` on a PUT means *only create, do not replace*,
      // and answering 304 to it would tell a client its write was skipped for
      // caching reasons.
      return isSafe(method) ? { kind: 'not-modified' } : failed;
    }
  } else if (isSafe(method) && preconditions.ifModifiedSince !== undefined) {
    // 4 · If-Modified-Since — **only** when If-None-Match is absent, and only
    // for a safe method.
    const since = parseHttpDate(preconditions.ifModifiedSince);
    if (since !== undefined) {
      const modified = validator?.lastModified;
      if (modified !== undefined && atSecond(modified) <= atSecond(since)) {
        return { kind: 'not-modified' };
      }
    }
  }

  // 5 · If-Range, and only for a GET carrying a Range.
  if (
    method.toUpperCase() === 'GET' &&
    preconditions.range !== undefined &&
    preconditions.ifRange !== undefined
  ) {
    return {
      kind: 'proceed',
      rangeApplicable: rangeStillValid(preconditions.ifRange, validator),
    };
  }

  return {
    kind: 'proceed',
    rangeApplicable: preconditions.range !== undefined,
  };
}

/**
 * `If-Range` — §13.1.5.
 *
 * **Strong comparison, and no weak tag is ever valid here**, for a reason worth
 * stating: a partial response is stitched into a cached representation, so
 * *semantically equivalent* is not good enough. Two representations a weak tag
 * calls equal may differ byte for byte, and splicing bytes from one into the
 * other produces a document that never existed.
 *
 * A date form is compared exactly rather than with the usual `<=`: §13.1.5
 * requires the origin to have a strong validator, and an exact match is the
 * only reading that gives one.
 */
function rangeStillValid(
  ifRange: string,
  validator: Validator | undefined,
): boolean {
  if (validator === undefined) return false;

  const asDate = parseHttpDate(ifRange);
  // A tag always starts with `"` or `W/`, so anything that parses as a date and
  // does not look like a tag is the date form.
  if (
    asDate !== undefined &&
    !ifRange.startsWith('"') &&
    !ifRange.startsWith('W/')
  ) {
    const modified = validator.lastModified;
    return modified !== undefined && atSecond(modified) === atSecond(asDate);
  }

  const list = parseTagList(ifRange);
  if (!list.ok || list.value.kind === 'wildcard') return false;
  const tag = list.value.tags[0];
  return tag !== undefined && strongEquals(tag, validator.etag);
}
