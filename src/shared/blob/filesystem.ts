/**
 * The real adapter: a directory on disk. **`I2`\'s second implementation.**
 *
 * **Not S3, and that is a decision rather than a shortcut.** `I2` asks for a
 * real adapter that passes the same contract as the twin, and the property
 * worth proving is that the port survives a store where writes land on real
 * bytes, reads stream, and a key is a path. A filesystem gives all three with
 * no account, no network and no credential — so `make test-integration` needs
 * nothing new, and a blueprint clone can run it.
 *
 * S3 is the same port with a different `put`. Adding it is a file beside this
 * one, which is exactly what `MODULES.md` §3 means by *a second service is a
 * file, not a redesign* — and the contract suite is what makes that true rather
 * than hoped for.
 *
 * **The key is the path, and that is why the key is a value object.** Every
 * traversal defence lives in `key.ts`; this resolves and then checks that the
 * result is still inside the root, which is the belt to that braces — a
 * `realpath` check catches a symlink somebody placed inside the tree, which no
 * amount of string validation can see.
 */

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import {
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { type Readable } from 'node:stream';
import { internal, invalid, notFound } from '../errors/index.js';
import { type BlobKey, parseKey } from './key.js';
import { type BlobInfo, type Blobs } from './port.js';

export interface FilesystemOptions {
  /** The root. Everything lives under it and nothing escapes it. */
  readonly root: string;
  readonly clock: { now(): Date };
}

/** Content type is not a filesystem concept, so it is stored beside the file. */
const META = '.content-type';

export function filesystemBlobs(options: FilesystemOptions): Blobs {
  /**
   * **The root itself may be a symlink, and on macOS it usually is.**
   *
   * `/var` is a link to `/private/var`, so every `mkdtemp` path resolves
   * somewhere the configured root does not prefix — and the containment check
   * below rejected every write in the temporary directory the tests use. The
   * check was right; comparing a real path against a possibly-symlinked root is
   * what was wrong.
   */
  // **Created if absent.** A store that requires its directory to pre-exist
  // fails on first run with an `ENOENT` from `realpath` and nothing explaining
  // it — which is what happened the first time this was pointed at a fresh
  // `BLOB_ROOT`, and the process exited before the log had a line in it.
  mkdirSync(resolve(options.root), { recursive: true });
  const root = realpathSync(resolve(options.root));

  /**
   * Where a key lives on disk.
   *
   * `key.ts` has already refused every traversal it can see as a string. This
   * refuses one it cannot: a resolved path outside the root, which is what a
   * symlink planted inside the tree produces and what no pattern can catch.
   */
  const pathFor = (key: BlobKey): string => {
    const full = resolve(join(root, key));
    if (full !== root && !full.startsWith(root + sep)) {
      throw invalid('that key resolves outside the blob root');
    }
    return full;
  };

  const infoFor = async (key: BlobKey, path: string): Promise<BlobInfo> => {
    const stats = await stat(path);
    let contentType = 'application/octet-stream';
    try {
      const raw = await import('node:fs/promises').then((fs) =>
        fs.readFile(`${path}${META}`, 'utf8'),
      );
      contentType = raw.trim();
    } catch {
      // No sidecar: an object written by something else, or by an older
      // version. A default beats refusing to serve the bytes.
    }
    return {
      key,
      size: stats.size,
      contentType,
      storedAt: stats.mtime,
    };
  };

  return {
    async put(key, body: Readable, contentType) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });

      try {
        // **Streamed, never collected.** The whole reason the port is shaped
        // this way: a buffering write works until the export is real.
        await pipeline(body, createWriteStream(path));
        await writeFile(`${path}${META}`, contentType, 'utf8');
      } catch (error) {
        throw internal('could not store a blob', { cause: error });
      }

      // **After the symlink check that a resolve cannot do.** A path that
      // resolved inside the root can still be a symlink pointing out of it, and
      // `realpath` is the only thing that sees that.
      const real = await realpath(path);
      if (!real.startsWith(root + sep)) {
        await rm(path, { force: true });
        throw invalid('that key resolves outside the blob root');
      }

      return infoFor(key, path);
    },

    async get(key) {
      // **Outside the `try`, deliberately.** A containment refusal is a caller
      // error and must reach the caller; swallowing it made a traversal
      // attempt indistinguishable from a missing object, so nothing anywhere
      // would ever report one. Found by deleting the check and watching this
      // test pass — it was asserting *absent*, not *refused*.
      const path = pathFor(key);
      try {
        const info = await infoFor(key, path);
        return { info, body: createReadStream(path) };
      } catch {
        // Absent is normal, and a caller distinguishing *absent* from *broken*
        // through an exception is a caller that has to catch on the happy path.
        return undefined;
      }
    },

    async head(key) {
      const path = pathFor(key);
      try {
        return await infoFor(key, path);
      } catch {
        return undefined;
      }
    },

    async delete(key) {
      const path = pathFor(key);
      // `force` makes it idempotent: deleting what is not there is not an
      // error, which is what lets a sweep run twice.
      await rm(path, { force: true });
      await rm(`${path}${META}`, { force: true });
    },

    async list(prefix) {
      const base = pathFor(prefix);
      const found: BlobInfo[] = [];

      const walk = async (directory: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (entry.name.endsWith(META)) continue;
          const relative = full
            .slice(root.length + 1)
            .split(sep)
            .join('/');
          found.push(await infoFor(parseKey(relative), full));
        }
      };

      await walk(base);
      return found.sort((a, b) => a.key.localeCompare(b.key));
    },
  };
}

/** So the module has something to throw when a caller insists a blob exists. */
export function missing(key: BlobKey): Error {
  return notFound(`no blob at ${key}`);
}
