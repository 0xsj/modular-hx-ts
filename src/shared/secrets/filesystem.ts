/**
 * The little filesystem this module needs. **L1 runtime.**
 *
 * `secrets` reads files, which is I/O — and it sits at L1 rather than L2
 * because it needs no *service*: `../../../INFRASTRUCTURE.md` §4 lists it under
 * "Nothing". It reads local files once, at boot, before anything else exists.
 *
 * Declared as a small interface rather than a port with adapters and a contract
 * suite, for the same reason `id` declares `RandomBytes`: the consumer owns the
 * shape, and two methods do not earn L2's ceremony. What matters is that it is
 * **injectable**, so a test never writes to a real disk.
 *
 * Synchronous on purpose. Configuration is parsed before the process is doing
 * anything, and an async boot path would spread through `env`, the composition
 * root and every schema for no benefit.
 *
 * See `notes/patterns/secrets.md`.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface FileSystem {
  /** File contents as UTF-8. Throws if it is not readable. */
  read(path: string): string;
  /** Whether this path is a directory, which a Kubernetes secret mount is. */
  isDirectory(path: string): boolean;
  join(...segments: readonly string[]): string;
}

/**
 * A secret file is a credential, not a database.
 *
 * The cap turns "somebody pointed a reference at a log file" into a clear
 * failure rather than a process that reads a gigabyte into memory and then
 * fails somewhere less obvious.
 */
export const MAX_BYTES = 1_048_576;

export function nodeFileSystem(): FileSystem {
  return {
    read: (path) => {
      const stats = statSync(path);
      if (stats.size > MAX_BYTES) {
        throw new Error(
          `is ${String(stats.size)} bytes, over the ${String(MAX_BYTES)} byte limit for a secret`,
        );
      }
      return readFileSync(path, 'utf8');
    },

    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },

    join: (...segments) => join(...segments),
  };
}

/**
 * A filesystem made of strings, for tests.
 *
 * A path whose value is a record is a **directory**, which is how a Kubernetes
 * secret mount actually looks: one file per key. Reading `<dir>/<key>` finds
 * it, so the fake behaves the way the real one does rather than requiring the
 * test to know which shape it is exercising.
 */
export function fakeFileSystem(
  tree: Readonly<Record<string, string | Readonly<Record<string, string>>>>,
): FileSystem {
  return {
    read: (path) => {
      const entry = tree[path];
      if (typeof entry === 'string') return entry;

      const slash = path.lastIndexOf('/');
      if (slash !== -1) {
        const parent = tree[path.slice(0, slash)];
        const value =
          typeof parent === 'object'
            ? parent[path.slice(slash + 1)]
            : undefined;
        if (value !== undefined) return value;
      }

      throw new Error('no such file or directory');
    },

    isDirectory: (path) => typeof tree[path] === 'object',
    join: (...segments) => segments.join('/'),
  };
}
