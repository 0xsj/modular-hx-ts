/**
 * Canonical JSON and content identities. **L0 kernel** — pure, no I/O.
 *
 * **The parity mechanism.** This repository's claim is that the same
 * architecture holds with the language as the only variable. That claim is only
 * testable if `modular-hx-go` and this repository turn the same value into the
 * same bytes — otherwise every cross-repository comparison is comparing
 * serializers, and the conformance suite proves nothing.
 *
 * RFC 8785 (JSON Canonicalization Scheme) is the specification that makes that
 * possible, and it was written around ECMAScript's own number and string rules
 * precisely so a JavaScript implementation is the short one. `String(n)` and
 * `JSON.stringify(s)` are already exactly what the RFC requires; the work here
 * is key ordering, rejecting what JSON cannot carry, and refusing to guess.
 *
 * See `notes/techniques/digest.md`.
 */

import { createHash } from 'node:crypto';
import { type Brand, unsafeBrand } from '../brand/index.js';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/** `sha256:` followed by 64 lowercase hex characters. */
export type Digest = Brand<string, 'Digest'>;

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isDigest(value: string): value is Digest {
  return DIGEST_PATTERN.test(value);
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Where in the structure a problem was found: `user.roles.0`. */
type Path = readonly string[];

const at = (path: Path): string =>
  path.length === 0 ? '<root>' : path.join('.');

/**
 * Serialize one value, appending to `out`.
 *
 * Recursive, O(n log n) in the number of keys because each object's keys are
 * sorted. Depth is the structure's depth; JSON documents are not deep enough
 * for that to matter, and a cycle is caught rather than overflowing the stack.
 */
function write(
  value: unknown,
  path: Path,
  seen: Set<object>,
  out: string[],
): Result<void> {
  if (value === null) {
    out.push('null');
    return ok(undefined);
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return ok(undefined);

    case 'number': {
      if (!Number.isFinite(value)) {
        // JSON has no NaN or Infinity. Emitting `null`, as JSON.stringify does,
        // silently turns a broken computation into a valid document.
        return err(
          invalid(`${at(path)} is ${String(value)}, which JSON cannot carry`),
        );
      }
      // RFC 8785 §3.2.2.3 defers to ECMAScript's Number::toString, which is
      // exactly what String does — including "0" for -0 and "1e+21" for 1e21.
      out.push(String(value));
      return ok(undefined);
    }

    case 'string':
      // RFC 8785 §3.2.2.2 is JSON's own string escaping with the minimal
      // choices, which is precisely what JSON.stringify emits.
      out.push(JSON.stringify(value));
      return ok(undefined);

    case 'object':
      break;

    default:
      return err(
        invalid(`${at(path)} is a ${typeof value}, which JSON cannot carry`),
      );
  }

  const object: object = value;
  if (seen.has(object)) {
    return err(invalid(`${at(path)} is a cycle`));
  }
  seen.add(object);

  if (Array.isArray(object)) {
    out.push('[');
    for (const [index, element] of object.entries()) {
      if (index > 0) out.push(',');
      const written = write(element, [...path, String(index)], seen, out);
      if (!written.ok) return written;
    }
    out.push(']');
    seen.delete(object);
    return ok(undefined);
  }

  if (
    Object.getPrototypeOf(object) !== Object.prototype &&
    Object.getPrototypeOf(object) !== null
  ) {
    // A Date, a Map, a class instance. Each has a plausible encoding and no
    // agreed one, so guessing here is how two languages disagree quietly.
    return err(
      invalid(
        `${at(path)} is a ${object.constructor.name}, which has no canonical JSON form — convert it first`,
      ),
    );
  }

  // RFC 8785 §3.2.3: sort by UTF-16 code unit, which is what the default
  // string sort already does.
  const keys = Object.keys(object).sort();

  out.push('{');
  for (const [index, key] of keys.entries()) {
    const entry = (object as Record<string, unknown>)[key];
    if (entry === undefined) {
      // JSON.stringify drops these. Go has no `undefined`, so dropping is a
      // silent divergence between the two implementations of the same model.
      return err(
        invalid(
          `${at([...path, key])} is undefined — omit the key or use null`,
        ),
      );
    }

    if (index > 0) out.push(',');
    out.push(JSON.stringify(key), ':');

    const written = write(entry, [...path, key], seen, out);
    if (!written.ok) return written;
  }
  out.push('}');

  seen.delete(object);
  return ok(undefined);
}

/** The canonical JSON text of a value, per RFC 8785. */
export function canonicalize(value: unknown): Result<string> {
  const out: string[] = [];
  const written = write(value, [], new Set(), out);

  return written.ok ? ok(out.join('')) : err(written.error);
}

/** The canonical JSON of a value as UTF-8 bytes — what actually gets hashed. */
export function canonicalBytes(value: unknown): Result<Uint8Array> {
  const text = canonicalize(value);
  return text.ok ? ok(new TextEncoder().encode(text.value)) : err(text.error);
}

/** `sha256:…` over arbitrary bytes. */
export function digestOfBytes(bytes: Uint8Array): Digest {
  const hex = createHash('sha256').update(bytes).digest('hex');
  return unsafeBrand<string, 'Digest'>(`sha256:${hex}`);
}

/**
 * The content identity of a value: `sha256:` over its canonical JSON.
 *
 * Two values with the same identity are the same value, in any language that
 * implements RFC 8785 — which is the entire point.
 */
export function digest(value: unknown): Result<Digest> {
  const bytes = canonicalBytes(value);
  return bytes.ok ? ok(digestOfBytes(bytes.value)) : err(bytes.error);
}
