/**
 * Conditional requests. **L4 edge, position 9 of the `httpx` chain.**
 *
 * ```ts
 * chain({ ..., conditional: conditional({ validators }) }, route)
 * ```
 *
 * **This module ships in two halves, and only one of them exists today.**
 *
 * - **RFC 9110 fixes the first half**, so it is here and none of it is a guess:
 *   entity-tag grammar, the two comparison functions, precondition precedence
 *   per §13.2.2, and outcome selection.
 * - **The domain shapes the second half**, so it is an interface with no
 *   implementer: how a handler supplies its current validator. `validators.ts`.
 *
 * The same line the collection drew for the canonical-JSON fixtures, which
 * shipped before any domain existed because RFC 8785 fixed them, while the
 * conformance cases waited because they describe endpoints nobody had written.
 *
 * Note: `notes/patterns/conditional.md`.
 */

export {
  type ETag,
  type TagList,
  WILDCARD,
  formatETag,
  isValidOpaque,
  parseETag,
  parseTagList,
  strongETag,
  strongEquals,
  strongTagFor,
  strongTagForBytes,
  weakETag,
  weakEquals,
} from './etag.js';

export {
  type Outcome,
  type Preconditions,
  type Validator,
  evaluate,
  parseHttpDate,
} from './preconditions.js';

export { type Validators } from './validators.js';

export { type ConditionalOptions, conditional } from './middleware.js';
