/**
 * Nominal types. **L0 kernel** — pure, no I/O, no process state.
 *
 * TypeScript is structural: `UserId`, `OrgId` and `SessionId` are all `string`,
 * so passing one where another is meant compiles. Go gets nominal types from
 * `type UserId string` for free; here it costs a type-level tag.
 *
 * A brand is erased entirely at runtime. `UserId` **is** a `string` — it
 * serializes, concatenates and compares as one. What changes is that a plain
 * `string` cannot be passed where a `UserId` is required without going through
 * a constructor that validated it.
 *
 * Same-layer dependencies on `errors` and `result`, permitted by rule `S1`.
 * See `notes/patterns/brand.md`.
 */

import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/**
 * The tag key.
 *
 * `declare` plus `unique symbol`: it exists only in the type system, so nothing
 * is added to the value at runtime and `erasableSyntaxOnly` stays satisfied. A
 * string key would collide, appear in `Object.keys`, and survive
 * `JSON.stringify`.
 */
declare const tag: unique symbol;

/**
 * `Brand<string, 'UserId'>` is a string that only a `UserId` constructor
 * produces.
 *
 * Declare the type and its constructor under one name — TypeScript keeps type
 * and value in separate namespaces, so this reads as one thing at every use:
 *
 *     export type UserId = Brand<string, 'UserId'>;
 *     export const UserId = defineBrand<string, 'UserId'>('UserId', isUuid);
 */
export type Brand<Base, Tag extends string> = Base & { readonly [tag]: Tag };

/** The constructor, guard and asserting constructor for one brand. */
export interface Brander<Base, Tag extends string> {
  /** The tag, for messages and for tests that assert on it. */
  readonly name: Tag;

  /** Validate and construct. The only honest way in. */
  readonly make: (value: Base) => Result<Brand<Base, Tag>>;

  /** Narrow a value that is already the right base type. */
  readonly is: (value: Base) => value is Brand<Base, Tag>;

  /**
   * Construct, or throw.
   *
   * For literals whose validity is known at authoring time — seed data, test
   * fixtures, configuration defaults. In a use case, use `make`: a value that
   * arrived from outside can fail, and that failure is expected.
   */
  readonly expect: (value: Base) => Brand<Base, Tag>;
}

/**
 * Define a brand from a predicate.
 *
 * The predicate is the definition of the type. `UserId` is not "a string we
 * called a UserId"; it is "a string that passed `isUuid`". Everything
 * downstream can rely on that, which is the whole return on the ceremony.
 */
export function defineBrand<Base, Tag extends string>(
  name: Tag,
  isValid: (value: Base) => boolean,
): Brander<Base, Tag> {
  type Branded = Brand<Base, Tag>;

  const is = (value: Base): value is Branded => isValid(value);

  const make = (value: Base): Result<Branded> =>
    // The offending value is deliberately absent from the message. Brands wrap
    // identifiers, and also API keys and tokens — a constructor that echoes its
    // input puts secrets in logs, and this module cannot redact.
    is(value) ? ok(value) : err(invalid(`not a valid ${name}`));

  const expect = (value: Base): Branded => {
    if (!is(value)) throw invalid(`not a valid ${name}`);
    return value;
  };

  return { name, make, is, expect };
}

/**
 * Brand without checking.
 *
 * For the one place it is legitimate: reading a value back from a store that
 * validated it on the way in, where re-validating every row is cost without
 * information. Named so it is greppable, and so a reviewer can count the uses.
 */
export function unsafeBrand<Base, Tag extends string>(
  value: Base,
): Brand<Base, Tag> {
  return value as Brand<Base, Tag>;
}
