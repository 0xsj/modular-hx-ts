/**
 * Drop artifacts past their TTL. **`exports` app · task.**
 *
 * **In `app/task/` rather than `app/command/`.** `M4` requires an exported
 * command to take an explicit `Subject`, and a sweep has no caller — it is a
 * `jobs` step, and inventing a subject for it would satisfy the rule by
 * pretending.
 */

import { type Provenance } from '../../../../shared/provenance/index.js';
import { ExportEvent } from '../../domain/index.js';
import { type ExportsDeps } from '../ports.js';

/**
 * Drop artifacts past their TTL.
 *
 * **The bytes go first.** An export row that still names a key nobody can read
 * is a broken link; a blob with no row is an orphan the sweep will never find
 * again, because the sweep walks rows. So: delete the object, then forget the
 * key — and a crash between them leaves a row pointing at nothing, which the
 * next sweep fixes and a download reports as expired.
 */
export async function sweepExpired(
  deps: ExportsDeps,
  provenance: Provenance,
  limit = 100,
): Promise<number> {
  const now = deps.clock.now();
  const stale = await deps.exports.expired(now, limit);
  let swept = 0;

  for (const row of stale) {
    const key = row.blobKey;
    if (key === undefined) continue;

    await deps.blobs
      .delete(key as Parameters<typeof deps.blobs.delete>[0])
      .catch(() => undefined);

    if (!row.expire().changed) continue;
    await deps.transactor.within(async (work) => {
      await work.exports.save(row, work.writer);
      await work.publish(
        { name: ExportEvent.Expired, payload: { subject: row.id } },
        provenance,
      );
    });
    swept += 1;
  }

  return swept;
}
