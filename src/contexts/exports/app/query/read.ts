/**
 * Reads. **`exports` app · query.**
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import {
  type Operation,
  invisible,
} from '../../../../shared/operations/index.js';
import { type Export, exportId } from '../../domain/index.js';
import { type ExportsDeps } from '../ports.js';

/**
 * Poll an operation.
 *
 * **404 for one that is not the caller's**, which is the same rule the rest of
 * the collection follows: a 403 confirms it exists.
 */
export async function readOperation(
  deps: ExportsDeps,
  subject: Subject,
  operationId: string,
): Promise<Operation> {
  const found = await deps.operations.byId(operationId);
  if (found?.ownerId !== subjectId(subject)) {
    throw invisible();
  }
  return found;
}

/**
 * The export behind a download, **authorized at download time**.
 *
 * That is the whole reason a download is a separate route: authorization
 * decided when the export was *created* is a decision made before the artifact
 * existed and possibly hours before anybody reads it. Ownership, existence and
 * expiry are all asked here, now.
 */
export async function readForDownload(
  deps: ExportsDeps,
  subject: Subject,
  id: string,
): Promise<Export> {
  const row = await deps.exports.byId(exportId(id));
  if (row?.requestedBy !== subjectId(subject)) {
    throw invisible();
  }
  // An expired artifact is **invisible, not forbidden** — the same answer as
  // one that never existed, because the difference is not the caller's to
  // learn from a status code.
  if (!row.isServableAt(deps.clock.now())) throw invisible();
  return row;
}
