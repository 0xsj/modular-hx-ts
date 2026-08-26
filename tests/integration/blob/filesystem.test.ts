/**
 * The filesystem blob store, against the shared contract. **Rung 2 — and it
 * needs no daemon.**
 *
 * `I2` asks for a real adapter passing the same suite as the twin. A filesystem
 * gives real bytes, real streaming and a key that is a path, with no account,
 * no network and no credential — so a fresh clone can run this, which is worth
 * more than proving the same three properties against S3.
 *
 * Plus the one thing only a real filesystem can be asked: a symlink planted
 * inside the tree, which no amount of string validation sees.
 */

import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '../../../src/shared/clock/index.js';
import { blobContract } from '../../../src/shared/blob/blobtest.js';
import { blobKey, parseKey } from '../../../src/shared/blob/index.js';
import { filesystemBlobs } from '../../../src/shared/blob/index.js';

let root = '';
const clock = fakeClock();

// **Not gated on the database.** Rung 2 usually means Postgres; this rung-2
// suite needs a directory, so gating it behind a daemon would make it skip for
// a reason that has nothing to do with it.
describe('filesystem blob store', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'blobtest-'));
  });

  blobContract(() => ({
    name: 'filesystem',
    blobs: () => filesystemBlobs({ root, clock }),
  }));

  describe('what only a real filesystem proves', () => {
    it('refuses a key whose path resolves outside the root via a SYMLINK', async () => {
      // The defence `key.ts` cannot provide: the string is perfectly valid and
      // the resolved path is inside the root — it is what the path *points at*
      // that escapes, and only `realpath` sees that.
      const blobs = filesystemBlobs({ root, clock });
      const outside = await mkdtemp(join(tmpdir(), 'outside-'));
      await mkdir(join(root, 'acme'), { recursive: true });
      await symlink(outside, join(root, 'acme', 'escape')).catch(
        () => undefined,
      );

      const key = blobKey('acme', 'escape', 'stolen.csv');

      await expect(
        blobs.put(key, Readable.from([Buffer.from('x')]), 'text/csv'),
      ).rejects.toThrow();
    });

    it('refuses a traversing key that arrived from OUTSIDE the type system', async () => {
      // **The second line, and a breakage pass is what showed it needed a
      // test.** Removing the containment check failed nothing, because every
      // key in every other case is built by `blobKey` and cannot traverse.
      //
      // A key that arrived as a *string* — from a database row, a queue
      // payload, a request — has not been through the constructor, and a cast
      // is what that looks like in TypeScript. The check exists for exactly
      // that value, so this is exactly how to test it.
      const blobs = filesystemBlobs({ root, clock });
      // **A file that actually exists outside the root**, which is what makes
      // this a test of containment rather than of the file being absent. The
      // first version pointed at `../../etc/passwd` and passed with the check
      // deleted — `put` was refused by the `realpath` guard and `head` was
      // undefined because nothing was there. Neither answer came from the
      // check under test.
      const outside = await mkdtemp(join(tmpdir(), 'secrets-'));
      await writeFile(join(outside, 'passwd'), 'root:x:0:0', 'utf8');
      const escape = `${'../'.repeat(12)}${outside.replace(/^\//, '')}/passwd`;
      const forged = escape as unknown as ReturnType<typeof blobKey>;

      // A read must not reach it: `get`, `head` and `delete` have only the
      // string check between them and the filesystem.
      await expect(blobs.get(forged)).rejects.toThrow();
      await expect(blobs.head(forged)).rejects.toThrow();
      await expect(
        blobs.put(forged, Readable.from([Buffer.from('x')]), 'text/plain'),
      ).rejects.toThrow();
    });

    it('streams a body larger than any sensible buffer', async () => {
      // The reason the port is streaming rather than `put(key, Buffer)`: this
      // is the shape that works until somebody exports a real dataset.
      const blobs = filesystemBlobs({ root, clock });
      const key = blobKey('acme', 'exports', 'large.csv');
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const chunks = Array.from({ length: 64 }, () => chunk);

      const info = await blobs.put(key, Readable.from(chunks), 'text/csv');

      expect(info.size).toBe(64 * 64 * 1024);
    });

    it('ignores a stray file that is not an object', async () => {
      // A sidecar written beside the bytes is an implementation detail and must
      // not appear in a listing as an object of its own.
      const blobs = filesystemBlobs({ root, clock });
      const tenant = 'listing';
      await blobs.put(
        blobKey(tenant, 'exports', 'a.csv'),
        Readable.from([Buffer.from('a')]),
        'text/csv',
      );

      const found = await blobs.list(blobKey(tenant, 'exports'));

      expect(found.map((info) => info.key)).toEqual([
        parseKey(`${tenant}/exports/a.csv`),
      ]);
    });

    it('does not let a listing walk up out of its prefix', async () => {
      const blobs = filesystemBlobs({ root, clock });
      await blobs.put(
        blobKey('one', 'exports', 'mine.csv'),
        Readable.from([Buffer.from('m')]),
        'text/csv',
      );
      await blobs.put(
        blobKey('two', 'exports', 'theirs.csv'),
        Readable.from([Buffer.from('t')]),
        'text/csv',
      );

      const found = await blobs.list(blobKey('one', 'exports'));

      expect(found).toHaveLength(1);
    });

    it('writes a sidecar rather than guessing a type from an extension', async () => {
      // Guessing is the version that is wrong for every file somebody names
      // badly, and a store has no business having an opinion about names.
      const blobs = filesystemBlobs({ root, clock });
      const key = blobKey('acme', 'exports', 'oddly-named.dat');

      await blobs.put(key, Readable.from([Buffer.from('x')]), 'text/csv');

      expect((await blobs.head(key))?.contentType).toBe('text/csv');
    });

    it('reads back a file written by something else, with a default type', async () => {
      const blobs = filesystemBlobs({ root, clock });
      await mkdir(join(root, 'legacy', 'exports'), { recursive: true });
      await writeFile(join(root, 'legacy', 'exports', 'old.csv'), 'x', 'utf8');

      const found = await blobs.head(blobKey('legacy', 'exports', 'old.csv'));

      // A default beats refusing to serve bytes that are plainly there.
      expect(found?.contentType).toBe('application/octet-stream');
    });
  });
});
