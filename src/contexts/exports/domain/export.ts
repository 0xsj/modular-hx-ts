/**
 * The `Export` aggregate. **`exports` domain.**
 *
 * A request for derived data: a format, a scope, and eventually an artifact
 * that expires. Deliberately thin — the *state machine* of long-running work
 * lives in `operations` and is not this context\'s to reinvent, which is the
 * whole reason that module exists.
 *
 * What is this context\'s: what may be exported, in what format, and how long
 * the result lives.
 *
 * See `notes/domain/exports.md`.
 */

import { invalid } from '../../../shared/errors/index.js';
import { type ExportId } from './ids.js';

/**
 * What can be produced. **Closed**, because a format is a renderer and an open
 * set is a renderer somebody forgot to write.
 */
export const Format = {
  Csv: 'csv',
  Json: 'json',
} as const;

export type Format = (typeof Format)[keyof typeof Format];

const FORMATS: readonly string[] = Object.values(Format);

export function format(raw: string): Format {
  const found = FORMATS.find((one) => one === raw);
  if (found === undefined) {
    throw invalid(`not an export format: ${raw}`, [
      { field: 'format', message: `is not one of ${FORMATS.join(', ')}` },
    ]);
  }
  return found as Format;
}

/**
 * What is being exported. **One value today and a discriminant tomorrow.**
 *
 * `users` is what this blueprint has to export, and naming the field now rather
 * than assuming it is what stops the second dataset from being a second
 * endpoint.
 *
 * **One value, and it is not a placeholder for an empty second.** `audit` was
 * in this union briefly with nothing behind it, which would have shipped an
 * endpoint that accepted a request and produced an empty file — a silent
 * wrong answer, and worse than a 400 saying the dataset is not exportable.
 */
export const Dataset = {
  Users: 'users',
} as const;

export type Dataset = (typeof Dataset)[keyof typeof Dataset];

const DATASETS: readonly string[] = Object.values(Dataset);

export function dataset(raw: string): Dataset {
  const found = DATASETS.find((one) => one === raw);
  if (found === undefined) {
    throw invalid(`not an exportable dataset: ${raw}`, [
      { field: 'dataset', message: `is not one of ${DATASETS.join(', ')}` },
    ]);
  }
  return found as Dataset;
}

export interface ExportState {
  readonly id: ExportId;
  /** The operation a caller polls. **The same id**, which is the point. */
  readonly operationId: string;
  readonly dataset: Dataset;
  readonly format: Format;
  readonly requestedBy: string;
  readonly tenant: string;
  /** Where the artifact went. Absent until the work finishes. */
  readonly blobKey?: string | undefined;
  readonly rows?: number | undefined;
  readonly bytes?: number | undefined;
  /**
   * When the artifact stops being served. **Set when it is written**, not when
   * it is requested: a TTL measured from a request would expire an export that
   * took an hour to produce before anybody could read it.
   */
  readonly expiresAt?: Date | undefined;
  readonly requestedAt: Date;
  readonly version: number;
}

export class Export {
  #blobKey: string | undefined;
  #rows: number | undefined;
  #bytes: number | undefined;
  #expiresAt: Date | undefined;
  #version: number;

  readonly id: ExportId;
  readonly operationId: string;
  readonly dataset: Dataset;
  readonly format: Format;
  readonly requestedBy: string;
  readonly tenant: string;
  readonly requestedAt: Date;
  readonly baseVersion: number;

  private constructor(state: ExportState) {
    this.id = state.id;
    this.operationId = state.operationId;
    this.dataset = state.dataset;
    this.format = state.format;
    this.requestedBy = state.requestedBy;
    this.tenant = state.tenant;
    this.requestedAt = state.requestedAt;
    this.baseVersion = state.version;

    this.#blobKey = state.blobKey;
    this.#rows = state.rows;
    this.#bytes = state.bytes;
    this.#expiresAt = state.expiresAt;
    this.#version = state.version;
  }

  static request(
    id: ExportId,
    operationId: string,
    what: { dataset: Dataset; format: Format },
    requestedBy: string,
    tenant: string,
    at: Date,
  ): Export {
    return new Export({
      id,
      operationId,
      dataset: what.dataset,
      format: what.format,
      requestedBy,
      tenant,
      requestedAt: at,
      version: 1,
    });
  }

  static from(state: ExportState): Export {
    return new Export(state);
  }

  get blobKey(): string | undefined {
    return this.#blobKey;
  }
  get rows(): number | undefined {
    return this.#rows;
  }
  get bytes(): number | undefined {
    return this.#bytes;
  }
  get expiresAt(): Date | undefined {
    return this.#expiresAt;
  }
  get version(): number {
    return this.#version;
  }

  /**
   * Record where the artifact went.
   *
   * **The TTL starts here**, not at request time. An export that took an hour
   * to produce would otherwise arrive already expired, and the caller would
   * have no way to tell that from one that was never written.
   */
  stored(
    key: string,
    measured: { rows: number; bytes: number },
    at: Date,
    ttlMs: number,
  ): void {
    if (this.#blobKey !== undefined) {
      throw invalid('this export already has an artifact');
    }
    this.#blobKey = key;
    this.#rows = measured.rows;
    this.#bytes = measured.bytes;
    this.#expiresAt = new Date(at.getTime() + ttlMs);
    this.#version += 1;
  }

  /**
   * Is the artifact still servable?
   *
   * **Asked at download time**, which is the whole reason a download is a
   * separate route: an export that was readable when it finished is not
   * necessarily readable now, and a decision made at creation cannot know that.
   */
  isServableAt(now: Date): boolean {
    if (this.#blobKey === undefined) return false;
    if (this.#expiresAt === undefined) return false;
    return now.getTime() < this.#expiresAt.getTime();
  }

  /** Forget the artifact. The sweep\'s half; the bytes are `blob`\'s. */
  expire(): { readonly changed: boolean } {
    if (this.#blobKey === undefined) return { changed: false };
    this.#blobKey = undefined;
    this.#expiresAt = undefined;
    this.#version += 1;
    return { changed: true };
  }

  toState(): ExportState {
    return {
      id: this.id,
      operationId: this.operationId,
      dataset: this.dataset,
      format: this.format,
      requestedBy: this.requestedBy,
      tenant: this.tenant,
      ...(this.#blobKey === undefined ? {} : { blobKey: this.#blobKey }),
      ...(this.#rows === undefined ? {} : { rows: this.#rows }),
      ...(this.#bytes === undefined ? {} : { bytes: this.#bytes }),
      ...(this.#expiresAt === undefined ? {} : { expiresAt: this.#expiresAt }),
      requestedAt: this.requestedAt,
      version: this.#version,
    };
  }
}
