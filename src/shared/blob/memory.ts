/**
 * The in-memory blob store. **`STORAGE=memory` is a real mode** — `I1`.
 *
 * Buffers what it is given, which is the one honest difference from the real
 * adapter: an in-memory store *is* a buffer. The port stays streaming so the
 * real adapter can be, and so no caller writes code that only works because the
 * bytes were already in hand.
 */

import { Readable } from 'node:stream';
import { type BlobKey } from './key.js';
import { type BlobInfo, type Blobs } from './port.js';

interface Stored {
  readonly bytes: Buffer;
  readonly info: BlobInfo;
}

export interface BlobStore {
  readonly objects: Map<string, Stored>;
}

export function memoryBlobStore(): BlobStore {
  return { objects: new Map() };
}

async function collect(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks);
}

export function memoryBlobs(store: BlobStore, clock: { now(): Date }): Blobs {
  return {
    async put(key, body, contentType) {
      const bytes = await collect(body);
      const info: BlobInfo = {
        key,
        size: bytes.length,
        contentType,
        storedAt: clock.now(),
      };
      store.objects.set(key, { bytes, info });
      return info;
    },

    get(key) {
      const found = store.objects.get(key);
      return Promise.resolve(
        found === undefined
          ? undefined
          : { info: found.info, body: Readable.from([found.bytes]) },
      );
    },

    head(key) {
      return Promise.resolve(store.objects.get(key)?.info);
    },

    delete(key) {
      store.objects.delete(key);
      return Promise.resolve();
    },

    list(prefix) {
      return Promise.resolve(
        [...store.objects.values()]
          .filter((one) => one.info.key.startsWith(prefix))
          .map((one) => one.info)
          .sort((a, b) => a.key.localeCompare(b.key)),
      );
    },
  };
}

/** Every key held, for a test that wants to look inside. */
export function keysIn(store: BlobStore): readonly BlobKey[] {
  return [...store.objects.values()].map((one) => one.info.key);
}
