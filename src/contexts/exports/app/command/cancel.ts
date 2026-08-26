/**
 * Cancel. **`exports` app · command.**
 *
 * The sweep used to live here and moved to `app/task/`: `M4` requires an
 * exported command to take a `Subject`, and a sweep has no caller. See
 * `task/sweep.ts`.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { invisible } from '../../../../shared/operations/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { ExportEvent } from '../../domain/index.js';
import { type ExportsDeps } from '../ports.js';

/**
 * Cancel. **A state, not a kill.**
 *
 * The worker finds out at its next checkpoint. Nothing here interrupts
 * anything, and `operations` is explicit that it cannot.
 */
export async function cancelExport(
  deps: ExportsDeps,
  subject: Subject,
  operationId: string,
  provenance: Provenance,
): Promise<void> {
  const operation = await deps.operations.byId(operationId);
  // **404, never 403**, for one that is not the caller's — a 403 confirms it
  // exists and turns any id into an oracle for what other people are exporting.
  if (operation?.ownerId !== subjectId(subject)) {
    throw invisible();
  }

  // Idempotent, and refused for one that already succeeded: the artifact
  // exists, and pretending it does not is worse than saying no.
  if (!operation.cancel(deps.clock.now()).changed) return;

  await deps.transactor.within(async (work) => {
    await work.operations.save(operation, work.writer);
    await work.publish(
      { name: ExportEvent.Cancelled, payload: { subject: operationId } },
      provenance,
    );
  });
}
