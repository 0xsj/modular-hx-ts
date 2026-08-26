/**
 * Request an export. **`exports` app · command.**
 *
 * Three writes, one commit: the export row, the operation a caller polls, and
 * the queue entry that will do the work. **Any two without the third is a state
 * nobody has code for** — an operation with no job says *running* forever, a
 * job with no export dereferences nothing, and an export with no operation is
 * work nobody can find.
 *
 * See `notes/domain/exports.md`.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { Operation, locationOf } from '../../../../shared/operations/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Dataset,
  type Format,
  Export,
  ExportEvent,
  exportId,
} from '../../domain/index.js';
import { type ExportsDeps } from '../ports.js';

export interface RequestInput {
  readonly dataset: Dataset;
  readonly format: Format;
}

export interface Accepted {
  readonly id: string;
  readonly operationId: string;
  /** What goes in the `Location` header — conformance case 45. */
  readonly location: string;
  readonly state: 'running';
}

/** `type:verb`, matching the resource — `authz` §subject. */
export const CREATE_EXPORT = 'export:create';

export async function requestExport(
  deps: ExportsDeps,
  subject: Subject,
  input: RequestInput,
  provenance: Provenance,
): Promise<Accepted> {
  const at = deps.clock.now();
  const id = exportId(deps.ids.uuid());
  const owner = subjectId(subject);

  // **One id for the export and its operation.** Two would mean a caller polls
  // one thing and downloads another, and every route would need a lookup to
  // relate them — which is a join that exists only because two ids were minted
  // where one would do.
  const operation = Operation.start(id, 'export', owner, subject.tenant, at);

  const row = Export.request(
    id,
    operation.id,
    { dataset: input.dataset, format: input.format },
    owner,
    subject.tenant,
    at,
  );

  await deps.transactor.within(async (work) => {
    await work.exports.create(row, work.writer);
    await work.operations.create(operation, work.writer);
    // **The queue entry, in the same transaction.** `work`'s whole port shape
    // exists for this line: a job enqueued outside it is a job for a row that
    // may not be there.
    await work.queue.enqueue(
      'export',
      { exportId: id },
      provenance,
      at,
      work.writer,
    );

    await work.publish(
      {
        name: ExportEvent.Requested,
        payload: {
          subject: id,
          dataset: input.dataset,
          format: input.format,
        },
      },
      provenance,
    );
  });

  return {
    id,
    operationId: operation.id,
    location: locationOf(operation.id),
    state: 'running',
  };
}
