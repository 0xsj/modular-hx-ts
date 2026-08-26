/**
 * The out-ports. **Declared by `app/`, injected by the root** — `S8`.
 *
 * This is the first context that needs three substrate modules at once, and the
 * shape of `Work` is why: an export row, its operation and its queue entry all
 * commit together, or a caller polls an operation for work that never started.
 *
 * See `notes/domain/exports.md`.
 */

import { type Blobs } from '../../../shared/blob/index.js';
import { type Event, type Publisher } from '../../../shared/events/index.js';
import { type Operations } from '../../../shared/operations/index.js';
import { type Provenance } from '../../../shared/provenance/index.js';
import { type Queue } from '../../../shared/work/index.js';
import { type Export, type ExportId } from '../domain/index.js';

export interface Exports {
  byId(id: ExportId): Promise<Export | undefined>;
  /** By the operation a caller polls. The download route reads this. */
  byOperation(operationId: string): Promise<Export | undefined>;
  /** Artifacts past their TTL. What the sweep walks. */
  expired(now: Date, limit: number): Promise<readonly Export[]>;
  create(row: Export, writer?: unknown): Promise<void>;
  save(row: Export, writer?: unknown): Promise<void>;
}

/**
 * The rows an export renders. **A reader, not a repository.**
 *
 * `S6` forbids importing `identity` or `audit`, and this is the seam that
 * replaces it: the root supplies a function that yields rows, and this context
 * knows only that a dataset produces objects. The same shape `identity`'s
 * `OrgRoles` port has — declared by the consumer, satisfied by whoever has the
 * data, wired by the root.
 */
export interface Datasets {
  rows(
    dataset: string,
    tenant: string,
  ): AsyncIterable<Readonly<Record<string, unknown>>>;
}

/**
 * One unit of work.
 *
 * **`writer` reaches all three stores**, which is the reason this interface
 * exists rather than three separate transactors: the export row, the operation
 * and the queue entry are one commit.
 */
export interface Work {
  readonly exports: Exports;
  readonly operations: Operations;
  readonly queue: Queue;
  publish(event: Event, provenance: Provenance): Promise<void>;
  /** The handle to pass to anything that takes one. */
  readonly writer: unknown;
}

export interface Transactor {
  within<T>(work: (handle: Work) => Promise<T>): Promise<T>;
}

export interface ExportsDeps {
  readonly transactor: Transactor;
  readonly exports: Exports;
  readonly operations: Operations;
  readonly queue: Queue;
  readonly blobs: Blobs;
  readonly datasets: Datasets;
  readonly publisher: Publisher;
  readonly clock: { now(): Date };
  readonly ids: { uuid(): string };
  /** How long an artifact is served for. Measured from when it is written. */
  readonly artifactTtlMs: number;
}
