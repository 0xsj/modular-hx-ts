/**
 * Turning a lock name into a PostgreSQL advisory-lock key. **L2 substrate.**
 *
 * An advisory lock key is a **signed 64-bit integer**. Every string name has to
 * be hashed down to one, and that hash is a shared namespace across the entire
 * database — two subsystems that hash to the same integer block each other with
 * no error, no log line, and no way to tell from either side.
 *
 * So the derivation is documented rather than incidental:
 *
 * ```
 * key(namespace, name) = int64(first 8 bytes of sha256(namespace + ":" + name))
 * ```
 *
 * - **`sha256`**, because `digest` already uses it and a lock key is one more
 *   content identity. A weaker hash would collide sooner in the 64-bit space.
 * - **The namespace is mandatory** and is part of the hashed bytes, so
 *   `jobs:purge` and `leases:purge` cannot land on the same integer.
 * - **Signed**, because that is what `pg_advisory_lock(bigint)` takes. The top
 *   bit is not masked off — masking would halve the space for no benefit and
 *   would be a second thing to keep in step across languages.
 *
 * See `notes/patterns/lock.md`.
 */

import { digestOfBytes } from '../digest/index.js';

/** Reserved for this repository's own locks, so an application cannot collide. */
export const JOBS_NAMESPACE = 'modular-hx-ts/jobs';

const TWO_POW_64 = 1n << 64n;
const TWO_POW_63 = 1n << 63n;

/**
 * The advisory-lock key for a name.
 *
 * Deterministic and stable: changing it would mean a deploy mid-rollout where
 * old and new instances take *different* locks for the same job and both run.
 */
export function advisoryKey(namespace: string, name: string): bigint {
  const digest = digestOfBytes(
    new TextEncoder().encode(`${namespace}:${name}`),
  );
  // `sha256:` then 64 hex characters; the first 16 are the first 8 bytes.
  const unsigned = BigInt(
    `0x${digest.slice('sha256:'.length, 'sha256:'.length + 16)}`,
  );

  // Two's complement into the signed range PostgreSQL accepts.
  return unsigned >= TWO_POW_63 ? unsigned - TWO_POW_64 : unsigned;
}

/** The full name a lock is known by, for logs and for the memory adapter. */
export function qualify(namespace: string, name: string): string {
  return `${namespace}:${name}`;
}
