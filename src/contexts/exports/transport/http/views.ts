/**
 * What `exports` puts on the wire. Snake case — `CONFORMANCE.md` §3.5.
 */

import { type Operation } from '../../../../shared/operations/index.js';

export interface OperationView {
  readonly id: string;
  readonly kind: string;
  readonly state: string;
  readonly result?: {
    readonly href: string;
    readonly content_type?: string;
    readonly size?: number;
  };
  readonly error?: string;
  readonly started_at: string;
  readonly finished_at?: string;
}

/**
 * **`result.href` is a reference**, which is what conformance case 45 asserts
 * and what keeps authorization at download time rather than hours earlier.
 *
 * **Field by field, never a spread.** `result` used to be written
 * `result: operation.result`, and that one line published `contentType` on a
 * wire this file's own header promises is snake case — the domain value walked
 * through the boundary with its TypeScript spelling intact and nothing looked,
 * because a spread is precisely the operation that declines to look. Case 45
 * asserts only `href`, so the suite was never going to catch it either.
 */
export function operationView(operation: Operation): OperationView {
  return {
    id: operation.id,
    kind: operation.kind,
    state: operation.state,
    ...(operation.result === undefined
      ? {}
      : {
          result: {
            href: operation.result.href,
            ...(operation.result.contentType === undefined
              ? {}
              : { content_type: operation.result.contentType }),
            ...(operation.result.size === undefined
              ? {}
              : { size: operation.result.size }),
          },
        }),
    ...(operation.error === undefined ? {} : { error: operation.error }),
    started_at: operation.startedAt.toISOString(),
    ...(operation.finishedAt === undefined
      ? {}
      : { finished_at: operation.finishedAt.toISOString() }),
  };
}
