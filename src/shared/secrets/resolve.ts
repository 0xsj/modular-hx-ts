/**
 * Resolving secret references. **L1 runtime.**
 *
 * Wraps an `env` `Source`, so `../../../ARCHITECTURE.md` §8 holds without `env`
 * knowing anything happened: *any variable may hold a secret reference,
 * resolved before configuration is parsed.*
 *
 * ```ts
 * const secrets = resolving(fromProcess());
 * const config = load(secrets.source, SCHEMA);
 * ```
 *
 * See `notes/patterns/secrets.md`.
 */

import { type Problem, type Source } from '../env/index.js';
import { type FileSystem, nodeFileSystem } from './filesystem.js';
import { describe, literal, parse, type Reference } from './reference.js';

/**
 * A reference may point at another variable, which may itself be a reference.
 * Chains beyond this are a loop or a mistake, and either way the answer is the
 * same: say so rather than recurse.
 */
const MAX_DEPTH = 8;

export interface Resolved {
  /** Pass this to `env.load`. Identical in shape to what it wrapped. */
  readonly source: Source;

  /**
   * Every reference that could not be resolved.
   *
   * Collected rather than thrown, so a broken secret joins the rest of the
   * configuration problems and the operator sees **everything** wrong in one
   * pass — which is the whole behaviour `env` exists to provide, and throwing
   * here would defeat it for the one class of failure hardest to diagnose.
   *
   * **Populated as values are read, so call it after `load`.** Resolution is
   * lazy on purpose: resolving every variable up front would read files for
   * values this process never wants, and fail on a reference belonging to a
   * feature that is switched off.
   */
  problems(): readonly Problem[];
}

export function resolving(
  source: Source,
  filesystem: FileSystem = nodeFileSystem(),
): Resolved {
  const problems: Problem[] = [];

  /** Record why a reference could not be resolved. A statement, not a value. */
  const fail = (variable: string, message: string): void => {
    problems.push({ variable, message });
  };

  /** Follow one value, which may itself be a reference. */
  const follow = (
    variable: string,
    raw: string | undefined,
    depth: number,
  ): string | undefined => {
    if (raw === undefined) return undefined;

    // The escape, checked before anything else — `literal:env://x` is a
    // password that begins `env://`, not a reference. A chain may also *end*
    // in one, which is why this sits inside `follow` rather than at the entry.
    const escaped = literal(raw);
    if (escaped !== undefined) return escaped;

    const reference = parse(raw);
    if (reference === undefined) return raw;

    if (depth >= MAX_DEPTH) {
      fail(variable, `follows more than ${String(MAX_DEPTH)} references`);
      return undefined;
    }

    return reference.scheme === 'env'
      ? followEnv(variable, reference, depth)
      : readFile(variable, reference);
  };

  const followEnv = (
    variable: string,
    reference: Reference,
    depth: number,
  ): string | undefined => {
    const next = source.get(reference.target);
    if (next === undefined) {
      fail(variable, `${describe(reference)} is not set`);
      return undefined;
    }
    return follow(variable, next, depth + 1);
  };

  const readFile = (
    variable: string,
    reference: Reference,
  ): string | undefined => {
    const { target, key } = reference;

    try {
      // A Kubernetes secret mounts as a directory of one file per key, so
      // `file:///run/secrets/smtp#password` is `/run/secrets/smtp/password`.
      // `INFRASTRUCTURE.md` §7.1 calls this out as needing no new code, and it
      // only holds if the directory form is the first thing tried.
      if (key !== undefined && filesystem.isDirectory(target)) {
        return trim(filesystem.read(filesystem.join(target, key)));
      }

      const contents = filesystem.read(target);
      if (key === undefined) return trim(contents);

      const selected = select(contents, key);
      if (selected === undefined) {
        fail(variable, `${describe(reference)}: no such key in the file`);
        return undefined;
      }
      return selected;
    } catch (error) {
      // The path is safe to report; the contents never are, so only the
      // reference and the reason appear.
      const reason = error instanceof Error ? error.message : 'is unreadable';
      fail(variable, `${describe(reference)}: ${reason}`);
      return undefined;
    }
  };

  return {
    source: {
      get: (name) => follow(name, source.get(name), 0),
      names: () => source.names(),
    },
    problems: () => problems,
  };
}

/**
 * A file ends with a newline; a credential does not.
 *
 * `echo -n` is the usual advice and the usual thing forgotten, and a trailing
 * newline in a password produces an authentication failure that looks like a
 * wrong password.
 */
const trim = (value: string): string => value.replace(/\r?\n$/, '');

/**
 * Select one value out of a multi-valued file.
 *
 * JSON when it looks like JSON, `key=value` lines otherwise. Both are shapes a
 * secret manager actually writes, and guessing between them is safe because
 * neither can be mistaken for the other.
 */
function select(contents: string, key: string): string | undefined {
  const text = contents.trim();

  if (text.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') {
          return String(value);
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    if (line.slice(0, separator).trim() === key) {
      return line.slice(separator + 1).trim();
    }
  }

  return undefined;
}
