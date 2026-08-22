/**
 * What a secret reference looks like. **L1 runtime.**
 *
 * `../../../ARCHITECTURE.md` §8: any variable may hold a reference instead of a
 * literal, resolved **before** configuration is parsed. Two schemes, and only
 * two, because each answers a real deployment shape and a third would be a
 * plugin system nobody asked for.
 *
 * ```
 * SMTP_PASSWORD=file:///run/secrets/smtp#password
 * SMTP_PASSWORD=env://SMTP_PASSWORD_REAL
 * ```
 *
 * See `notes/patterns/secrets.md`.
 */

export type Scheme = 'file' | 'env';

/**
 * The escape hatch, so a reference syntax cannot make a password
 * unrepresentable.
 *
 * `../../../MODULES.md` §2: *every variable is scanned, with one escape — a
 * `literal:` prefix is stripped and the remainder returned verbatim, for the
 * password that genuinely begins `env://`.*
 *
 * **Rejected: a per-variable annotation** — `SMTP_PASSWORD_IS_LITERAL=1`, or a
 * flag on the reader. It puts the escape in the schema, where the person
 * writing the `.env` file cannot reach it, and doubles the surface for the rare
 * case. Keeping it inside the value keeps `.env` files free of annotation.
 */
const LITERAL = 'literal:';

/**
 * Strip the `literal:` escape, or `undefined` if the value is not escaped.
 *
 * **Verbatim means verbatim:** unlike a reference, the remainder is *not*
 * trimmed. A reference with surrounding whitespace is a typo; a password with a
 * trailing space is a password, and an escape that quietly edited the value it
 * was protecting would be worse than none.
 */
export function literal(raw: string): string | undefined {
  return raw.startsWith(LITERAL) ? raw.slice(LITERAL.length) : undefined;
}

export interface Reference {
  readonly scheme: Scheme;
  /** A filesystem path, or the name of another variable. */
  readonly target: string;
  /** Selects one value out of a multi-valued target. */
  readonly key?: string;
}

/**
 * Recognise a reference.
 *
 * Anything else is a literal and passes through untouched — a password may
 * legitimately begin with almost anything, so only these two prefixes are
 * special, and a value that merely *contains* `file://` is not a reference.
 *
 * A value that genuinely begins with one of them escapes as `literal:` — see
 * above, and note that the caller must check that **first**, since this
 * function would otherwise see the prefix inside the escaped value.
 */
export function parse(raw: string): Reference | undefined {
  const value = raw.trim();

  if (value.startsWith('env://')) {
    const target = value.slice('env://'.length);
    return target === '' ? undefined : { scheme: 'env', target };
  }

  if (!value.startsWith('file://')) return undefined;

  // `file:///run/secrets/smtp` — three slashes, the third beginning an absolute
  // path. A relative form is accepted too, because a test fixture and a local
  // run both want one.
  const rest = value.slice('file://'.length);
  const [path, key] = splitFragment(rest);

  if (path === '') return undefined;

  return key === undefined
    ? { scheme: 'file', target: path }
    : { scheme: 'file', target: path, key };
}

/**
 * Split on the **last** `#`.
 *
 * A path may contain one — rare, and cheaper to handle than to explain. The
 * fragment is the selector, so the last one wins.
 */
function splitFragment(value: string): [string, string | undefined] {
  const hash = value.lastIndexOf('#');
  if (hash === -1) return [value, undefined];

  const key = value.slice(hash + 1);
  return [value.slice(0, hash), key === '' ? undefined : key];
}

/** Render a reference for an error message. Targets are paths, never values. */
export function describe(reference: Reference): string {
  const suffix = reference.key === undefined ? '' : `#${reference.key}`;
  return `${reference.scheme}://${reference.target}${suffix}`;
}
