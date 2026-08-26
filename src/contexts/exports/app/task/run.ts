/**
 * Produce the artifact. **`exports` app · task.**
 *
 * **In `app/task/` rather than `app/command/`, because `M4` is right.** That
 * rule requires every exported command to take an explicit `Subject` —
 * *authorization is explicit, never ambient* — and this has no caller at all: a
 * `work` job hands it an export id, hours after the request that asked for one.
 * Giving it a `Subject` it ignores would satisfy the rule by pretending, which
 * is worse than the rule firing. A task is a different thing from a command and
 * now lives in a different directory.
 *
 * Everything it writes carries the provenance of the request that asked for it,
 * which is the honest version of *who wanted this*.
 *
 * **Cancellation is checked at a checkpoint**, which is the whole of what
 * cancellation can mean to work already running — `operations` cannot interrupt
 * a syscall and does not claim to.
 */

import { type Provenance } from '../../../../shared/provenance/index.js';
import { blobKey } from '../../../../shared/blob/index.js';
import { type ExportId, ExportEvent, exportId } from '../../domain/index.js';
import { type ExportsDeps } from '../ports.js';
import { Readable } from 'node:stream';

/** How often the worker asks whether it is still wanted. */
const CHECKPOINT_ROWS = 500;

/**
 * Render rows to bytes. **Streamed**, so an export is bounded by the store
 * rather than by memory.
 */
async function* render(
  rows: AsyncIterable<Readonly<Record<string, unknown>>>,
  format: string,
  onRow: () => Promise<boolean>,
): AsyncGenerator<Buffer> {
  let header = false;
  let count = 0;
  let first = true;

  if (format === 'json') yield Buffer.from('[');

  for await (const row of rows) {
    count += 1;
    if (count % CHECKPOINT_ROWS === 0 && !(await onRow())) return;

    if (format === 'json') {
      yield Buffer.from((first ? '' : ',') + JSON.stringify(row));
      first = false;
      continue;
    }

    const keys = Object.keys(row);
    if (!header) {
      yield Buffer.from(`${keys.map(csv).join(',')}\n`);
      header = true;
    }
    yield Buffer.from(`${keys.map((key) => csv(row[key])).join(',')}\n`);
  }

  if (format === 'json') yield Buffer.from(']');
}

/**
 * One CSV field.
 *
 * Quoted whenever it could be misread, and a quote inside is doubled — RFC
 * 4180. A naive `join(',')` is the version that works until a display name has
 * a comma in it, which is the first real dataset.
 */
function csv(value: unknown): string {
  const text = cell(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * One value as text.
 *
 * **`String({})` is `[object Object]`**, which is a cell that says nothing and
 * looks like data. Anything that is not a scalar is serialized rather than
 * stringified, and a function or a symbol — neither of which survives a wire
 * format — becomes empty rather than a name nobody asked for.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object':
      return JSON.stringify(value);
    default:
      return '';
  }
}

export async function runExport(
  deps: ExportsDeps,
  id: string,
  provenance: Provenance,
): Promise<void> {
  const row = await deps.exports.byId(exportId(id));
  if (row === undefined) {
    // The export was swept or never committed. Not an error worth retrying —
    // there is nothing to produce and the job has no target.
    return;
  }

  const operation = await deps.operations.byId(row.operationId);
  if (operation === undefined || operation.terminal) {
    // **Already settled**, which includes cancelled. A worker that finished
    // after a cancellation must not overwrite what a caller has read, and the
    // aggregate would refuse it anyway — this just avoids doing the work.
    return;
  }

  const key = blobKey(row.tenant, 'exports', `${row.id}.${row.format}`);

  let rows = 0;
  const cancelled = async (): Promise<boolean> => {
    // **The checkpoint.** Re-read rather than trusting the copy taken at the
    // start: cancellation happens while this is running or it means nothing.
    const now = await deps.operations.byId(row.operationId);
    return now?.abandoned !== true;
  };

  try {
    const source = deps.datasets.rows(row.dataset, row.tenant);
    const counted = (async function* () {
      for await (const one of source) {
        rows += 1;
        yield one;
      }
    })();

    const stored = await deps.blobs.put(
      key,
      Readable.from(render(counted, row.format, cancelled)),
      row.format === 'csv' ? 'text/csv' : 'application/json',
    );

    // Asked once more before settling: a cancellation that arrived during the
    // write should not produce a `succeeded` a caller was told would not come.
    if (!(await cancelled())) {
      await deps.blobs.delete(key);
      return;
    }

    const at = deps.clock.now();
    row.stored(key, { rows, bytes: stored.size }, at, deps.artifactTtlMs);
    operation.succeed(
      {
        href: `/v1/exports/${row.id}/download`,
        contentType: stored.contentType,
        size: stored.size,
      },
      at,
    );

    await deps.transactor.within(async (work) => {
      await work.exports.save(row, work.writer);
      await work.operations.save(operation, work.writer);
      await work.publish(
        {
          name: ExportEvent.Completed,
          payload: { subject: row.id, rows, bytes: stored.size },
        },
        provenance,
      );
    });
  } catch (error) {
    // **The artifact goes with the failure.** A half-written object nobody can
    // reach is a bill, and leaving it would make the sweep's job ambiguous.
    await deps.blobs.delete(key).catch(() => undefined);

    const at = deps.clock.now();
    const fresh = await deps.operations.byId(row.operationId);
    if (fresh === undefined || fresh.terminal) throw error;

    fresh.fail(String(error), at);
    await deps.transactor.within(async (work) => {
      await work.operations.save(fresh, work.writer);
      await work.publish(
        {
          name: ExportEvent.Failed,
          payload: { subject: row.id, error: String(error) },
        },
        provenance,
      );
    });
    // **Rethrown**, so `work` counts the attempt and eventually dead-letters.
    // Swallowing it would make a permanently failing export look completed to
    // the queue and leave nothing to investigate.
    throw error;
  }
}

export type { ExportId };
