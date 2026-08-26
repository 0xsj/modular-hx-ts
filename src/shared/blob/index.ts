/**
 * Object storage, behind a port. **L2 substrate.**
 *
 * Two things this module is about, and the second is the one that bites:
 *
 * - **Streaming.** An export is arbitrarily large, and a buffering signature
 *   works until somebody exports a real dataset.
 * - **Keys.** A key derived from user input is a path traversal waiting for a
 *   concatenation, and **tenant-scoped means the key encodes the tenant**
 *   rather than a filter applying one — a filter is a `where` clause somebody
 *   forgets, and the forgetting has no symptom until a customer reads another
 *   customer\'s file.
 *
 * See `notes/patterns/blob.md`.
 */

export { type BlobKey, blobKey, parseKey, within } from './key.js';
export { type BlobInfo, type Blobs } from './port.js';
export {
  type BlobStore,
  keysIn,
  memoryBlobStore,
  memoryBlobs,
} from './memory.js';
export { type FilesystemOptions, filesystemBlobs } from './filesystem.js';
