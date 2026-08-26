/**
 * One place for "this must never print". **L0 kernel** — pure, no I/O.
 *
 * `../MODULES.md` marks this **×5**: written five times in v1 and never
 * extracted. The rule that produced it — the third copy gets extracted, two may
 * be coincidence and three is a pattern — is why it is a module here.
 *
 * A secret is **unprintable by construction**. The failure this prevents is
 * never a considered decision; it is a `console.log` added while debugging, a
 * template literal in an error message, or an object spread into a log line.
 * Discipline does not survive those. A type that cannot print itself does.
 *
 * TypeScript gives four independent ways to turn a value into text, and missing
 * any one leaks through a different path:
 *
 *   `${x}` and String(x)  → Symbol.toPrimitive, then toString
 *   JSON.stringify(x)     → toJSON
 *   console.log(x)        → nodejs.util.inspect.custom
 *   x.toString()          → toString
 *
 * All four are covered, and the value itself lives in a `#private` field, which
 * `Object.keys`, spread and structured clone cannot reach either.
 *
 * See `notes/patterns/redact.md`.
 */

export const REDACTED = '[redacted]';

/**
 * Node calls this when `console.log` formats a value. Referenced by its
 * well-known key rather than importing `node:util`, so the module stays free of
 * platform imports.
 */
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export interface Secret<T> {
  /**
   * The value, deliberately verbose and greppable.
   *
   * Every call site is a place where a secret enters plain memory, and a
   * reviewer should be able to find all of them with one search.
   */
  expose(): T;

  /**
   * Always `[redacted]`.
   *
   * Declared on the interface, not just implemented on the class, so the
   * guarantee is visible in the type. Without it a caller only learns this is
   * safe by reading the implementation — and lint reasonably assumes any
   * interface without `toString` stringifies as `[object Object]`.
   */
  toString(): string;

  /** Always `[redacted]`. */
  toJSON(): string;
}

class SecretValue<T> implements Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  expose(): T {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }

  readonly [Symbol.toStringTag] = 'Secret';
}

/** Wrap a value so it cannot be printed by accident. */
export function secret<T>(value: T): Secret<T> {
  return new SecretValue(value);
}

export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof SecretValue;
}

/**
 * Key fragments whose values never print.
 *
 * Matched as substrings against a key with case and separators stripped, so
 * `apiKey`, `api_key`, `API-KEY` and the `X-Api-Key` header all reduce to the
 * same thing. Separators are the gap that matters: header names are hyphenated,
 * JSON bodies are camel or snake, and a list written in one convention silently
 * misses the others.
 *
 * Substrings over-match sometimes — a field named `tokenCount` is redacted —
 * and that is the right direction to be wrong in: a redacted metric is a
 * nuisance, a logged bearer token is an incident.
 *
 * **Except for the short ones.** A fragment of three characters or fewer —
 * `ssn`, `pan` — matches a whole **segment** rather than any substring, because
 * at that length the substring rule stops being a small over-match and starts
 * being a wrong one: `span` is not a primary account number, and neither are
 * `panel` or `expand`. `card_pan`, `cardPan` and `PAN` still redact, because
 * segments survive both conventions.
 */
export const SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'auth',
  'cookie',
  'session',
  'credential',
  'privatekey',
  'signature',
  'ssn',
  'pan',
];

/**
 * Whether this is a bag of fields, as opposed to a value that happens to be an
 * object. Arrays and plain objects only — including `Object.create(null)`,
 * which is what a parsed query string or a header map often is.
 */
function isTraversable(value: object): boolean {
  if (Array.isArray(value)) return true;

  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The words in a key. `X-Api-Key`, `api_key` and `apiKey` all give the same. */
const segmentsOf = (key: string): readonly string[] =>
  key
    // A camelCase hump is a word boundary, and the only one with no character
    // to split on.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((segment) => segment !== '')
    .map((segment) => segment.toLowerCase());

/** Below this length a fragment is a word, not a substring. See above. */
const WHOLE_SEGMENT_AT_OR_BELOW = 3;

/**
 * Is this field name one that carries a secret?
 *
 * Exported because `redactKeys` is not the only thing that needs the answer: a
 * caller that wants to **alias** a value rather than replace it — a journal
 * that must stay legible — needs the same vocabulary, and a second list of
 * sensitive names is a list that disagrees with this one.
 */
export const isSensitiveKey = (
  key: string,
  fragments: readonly string[] = SENSITIVE_KEYS,
): boolean => isSensitive(key, fragments);

const isSensitive = (key: string, fragments: readonly string[]): boolean => {
  // Strip case and separators: `X-Api-Key`, `api_key` and `apiKey` are one key.
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  const segments = segmentsOf(key);

  return fragments.some((fragment) =>
    fragment.length <= WHOLE_SEGMENT_AT_OR_BELOW
      ? segments.includes(fragment)
      : normalized.includes(fragment),
  );
};

/**
 * A copy of a structure with sensitive values replaced.
 *
 * For the log line and the error payload — the places a whole object gets
 * handed to something that prints. `Secret` covers a value you own; this covers
 * a bag of fields you were given, such as a request body or a header map.
 *
 * O(n) in the number of nodes. Cycles are replaced with `[circular]` rather
 * than overflowing the stack, because the value being logged is often the one
 * that is already malformed.
 */
export function redactKeys(
  value: unknown,
  fragments: readonly string[] = SENSITIVE_KEYS,
  seen = new Set<object>(),
): unknown {
  if (isSecret(value)) return REDACTED;
  if (value === null || typeof value !== 'object') return value;

  // Only plain objects and arrays are traversed. Everything else — an Error, a
  // Date, a Map, a URL, a Buffer — is a **leaf**, and rebuilding one from its
  // enumerable properties destroys it: `Error.message` and `.stack` are not
  // enumerable, a `Date` has no own properties at all, and every one of them
  // loses its prototype, so `instanceof` downstream returns false.
  //
  // Both halves of that were live bugs. An error reached a log line with its
  // message gone; a `Date` arrived as `{}`. Traversal is for bags of fields,
  // and a `Date` is not a bag of fields.
  //
  // A secret inside a leaf belongs in a `Secret`, which redacts itself wherever
  // it is printed.
  if (!isTraversable(value)) return value;

  if (seen.has(value)) return '[circular]';

  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.map((element) => redactKeys(element, fragments, seen));
    seen.delete(value);
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitive(key, fragments)
      ? REDACTED
      : redactKeys(entry, fragments, seen);
  }

  seen.delete(value);
  return out;
}

/**
 * Reveal the last few characters of a value and hide the rest.
 *
 * For the support case: "the key ending 5678". Anything short enough that the
 * revealed part would be most of it is hidden completely — a four-character
 * PIN masked to its last two is not masked.
 */
export function mask(value: string, revealLast = 4): string {
  if (revealLast < 0 || value.length <= revealLast * 2) return REDACTED;

  return `${REDACTED}${value.slice(-revealLast)}`;
}
