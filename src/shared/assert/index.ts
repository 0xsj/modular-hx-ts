/**
 * Invariant helpers. **L0 kernel** — pure, no I/O, no process state.
 *
 * These throw. That is the point, and it is the other half of the rule `result`
 * encodes: **a failure you expected is a value; a failure you did not is a
 * throw.** An assertion fires on a condition the code believes impossible, so
 * there is nothing for a caller to handle — every one of these raises an
 * `Internal` error, the only kind that should page anyone.
 *
 * If a condition here can be reached by anything a user typed, it was never an
 * invariant, and it belongs in a `Result`.
 *
 * `../MODULES.md` pairs this with `brand`: brand covers identity, assert covers
 * invariants. Same-layer dependency on `errors`, permitted by rule `S1`.
 * See `notes/patterns/assert.md`.
 */

import { internal } from '../errors/index.js';

/**
 * Render a value for a message.
 *
 * Primitives only. An object could be a whole aggregate — or a secret — and an
 * assertion message ends up in a log, so structural values are described by
 * their type rather than their contents.
 */
function describe(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value.length <= 64 ? `"${value}"` : `"${value.slice(0, 64)}…"`;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'undefined':
      return 'undefined';
    default:
      return value === null ? 'null' : `[${typeof value}]`;
  }
}

/**
 * Fail unless a condition holds.
 *
 * `asserts condition` narrows for everything after the call, so this replaces
 * an `if (!x) throw` **and** the cast that usually follows it.
 */
export function invariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw internal(`invariant violated: ${message}`);
}

/**
 * Fail unless a value is neither `null` nor `undefined`, and narrow it.
 *
 * Under `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` this comes
 * up constantly: the type says the value might be missing, the code knows it is
 * not, and the alternative is a non-null assertion that says nothing about why.
 */
export function assertDefined<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value === null || value === undefined) {
    throw internal(`expected ${message} to be defined, got ${describe(value)}`);
  }
}

/**
 * `assertDefined`, as an expression.
 *
 * For the places a statement will not fit — an argument, a property, the right
 * side of a `const`. `must(rows.at(0), 'first row')` reads better than a bang,
 * and unlike a bang it explains itself when it fires at three in the morning.
 */
export function must<T>(value: T, message: string): NonNullable<T> {
  assertDefined(value, message);
  return value;
}

/**
 * Fail on a case that should not exist.
 *
 * The exhaustiveness check. Because the parameter is `never`, adding a member
 * to a union turns every unhandled `switch` into a **compile** error rather
 * than a silent fallthrough — which is precisely the failure the `errors` note
 * warns about, where a new `Kind` quietly becomes a 500.
 *
 *     switch (kind) {
 *       case 'not_found': return 404;
 *       // …
 *       default: return assertNever(kind, 'Kind');
 *     }
 */
export function assertNever(value: never, subject = 'value'): never {
  // `value` is `never` to the compiler and a real discriminant at runtime —
  // which is why rendering it is worth it: without it the message says a case
  // was missed but not which one.
  throw internal(`unhandled ${subject}: ${describe(value)}`);
}

/** Fail at a point that should not be reachable at all. */
export function unreachable(message: string): never {
  throw internal(`unreachable: ${message}`);
}
