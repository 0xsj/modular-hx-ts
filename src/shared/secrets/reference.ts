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
