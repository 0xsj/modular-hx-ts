/**
 * One contract suite; both adapters pass it. **Test tooling** — rule `S3`.
 *
 * Separate tests would prove both stores work. **One suite run twice proves
 * they agree**, which is what `I2` is about.
 *
 * The cases that matter are the ones a memory map and a filesystem could
 * plausibly answer differently: an absent key, a round trip of exact bytes, a
 * listing that does not escape its prefix, and a delete that is idempotent.
 */

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type BlobKey, blobKey } from './key.js';
import { type Blobs } from './port.js';

export interface Subject {
  readonly name: string;
  readonly blobs: () => Blobs;
}

let counter = 0;
const nextKey = (tenant = 'acme'): BlobKey =>
  blobKey(tenant, 'exports', `object-${String(++counter)}.csv`);

const from = (text: string): Readable => Readable.from([Buffer.from(text)]);

async function read(body: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function blobContract(subject: () => Subject): void {
  describe('round trip', () => {
    it('reads back exactly what was written', async () => {
      const blobs = subject().blobs();
      const key = nextKey();
      // Bytes that survive neither a naive encoding nor a naive split.
      const body = 'id,name\n1,"Ada, Countess"\n2,\u00e9\u00e8\n';

      await blobs.put(key, from(body), 'text/csv');
      const found = await blobs.get(key);

      expect(found).toBeDefined();
      expect(await read(found?.body ?? Readable.from([]))).toBe(body);
    });

    it('reports the size it actually stored', async () => {
      // Returned rather than predicted: a caller that computed a length from a
      // string it was handed records a number the store never saw.
      const blobs = subject().blobs();
      const key = nextKey();

      const info = await blobs.put(key, from('12345'), 'text/plain');

      expect(info.size).toBe(5);
      expect((await blobs.head(key))?.size).toBe(5);
    });

    it('keeps the content type, which a filesystem has no idea about', async () => {
      const blobs = subject().blobs();
      const key = nextKey();

      await blobs.put(key, from('x'), 'text/csv');

      expect((await blobs.head(key))?.contentType).toBe('text/csv');
    });

    it('overwrites rather than appending', async () => {
      const blobs = subject().blobs();
      const key = nextKey();

      await blobs.put(key, from('first'), 'text/plain');
      await blobs.put(key, from('second'), 'text/plain');

      expect(
        await read((await blobs.get(key))?.body ?? Readable.from([])),
      ).toBe('second');
    });
  });

  describe('absence', () => {
    it('is undefined rather than an error', async () => {
      // A caller distinguishing *absent* from *broken* through an exception is
      // a caller that has to catch on the happy path.
      const blobs = subject().blobs();

      expect(await blobs.get(nextKey())).toBeUndefined();
      expect(await blobs.head(nextKey())).toBeUndefined();
    });

    it('makes delete idempotent, so a sweep can run twice', async () => {
      const blobs = subject().blobs();
      const key = nextKey();

      await blobs.put(key, from('x'), 'text/plain');
      await blobs.delete(key);
      await blobs.delete(key);

      expect(await blobs.get(key)).toBeUndefined();
    });
  });

  describe('listing', () => {
    it('returns what is under the prefix', async () => {
      const blobs = subject().blobs();
      const tenant = `t${String(++counter)}`;
      const one = blobKey(tenant, 'exports', 'a.csv');
      const two = blobKey(tenant, 'exports', 'b.csv');

      await blobs.put(one, from('a'), 'text/csv');
      await blobs.put(two, from('b'), 'text/csv');

      const found = await blobs.list(blobKey(tenant, 'exports'));

      expect(found.map((info) => info.key)).toEqual([one, two]);
    });

    it('does NOT escape into another tenant', async () => {
      // The property the key type exists for, asserted at the store as well:
      // a prefix carries a tenant because `blobKey` cannot build one without.
      const blobs = subject().blobs();
      const mine = `t${String(++counter)}`;
      const theirs = `t${String(++counter)}`;

      await blobs.put(blobKey(mine, 'exports', 'a.csv'), from('a'), 'text/csv');
      await blobs.put(
        blobKey(theirs, 'exports', 'b.csv'),
        from('b'),
        'text/csv',
      );

      const found = await blobs.list(blobKey(mine, 'exports'));

      expect(found).toHaveLength(1);
      expect(found[0]?.key.startsWith(`${mine}/`)).toBe(true);
    });

    it('is empty for a prefix with nothing under it', async () => {
      const blobs = subject().blobs();

      expect(
        await blobs.list(blobKey(`t${String(++counter)}`, 'nothing')),
      ).toEqual([]);
    });
  });
}
