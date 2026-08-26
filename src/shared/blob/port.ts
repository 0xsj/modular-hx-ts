/**
 * The blob store, behind a port. **L2 substrate.**
 *
 * `ARCHITECTURE.md` §L2: a port, a memory adapter, a real adapter, one contract
 * suite both pass — `I2`.
 *
 * **Streaming, not buffering.** An export is the reason this module exists and
 * an export is arbitrarily large; a `put(key, Buffer)` signature is one that
 * works until somebody exports a real dataset and the process dies holding it.
 * The stream types are Node\'s, which is the one place a substrate module is
 * allowed to name a runtime.
 */

import { type Readable } from 'node:stream';
import { type BlobKey } from './key.js';

export interface BlobInfo {
  readonly key: BlobKey;
  readonly size: number;
  readonly contentType: string;
  readonly storedAt: Date;
}

export interface Blobs {
  /**
   * Write. **Returns what was written**, so a caller records a size it
   * observed rather than one it predicted.
   */
  put(key: BlobKey, body: Readable, contentType: string): Promise<BlobInfo>;

  /** Read. `undefined` for absent — never an error, because absent is normal. */
  get(key: BlobKey): Promise<{ info: BlobInfo; body: Readable } | undefined>;

  /** Metadata without the bytes, for a listing or a HEAD. */
  head(key: BlobKey): Promise<BlobInfo | undefined>;

  /** Idempotent: deleting what is not there is not an error. */
  delete(key: BlobKey): Promise<void>;

  /**
   * Keys under a prefix, **within one tenant**.
   *
   * The prefix is built with `blobKey`, so it carries a tenant and a listing
   * cannot escape one. A `list(prefix: string)` taking a bare string is the
   * signature that lets somebody pass `''`.
   */
  list(prefix: BlobKey): Promise<readonly BlobInfo[]>;
}
