/**
 * RFC 9457 problem responses. **L4 edge.**
 *
 * **Invariant `I7`: errors are mapped to transport codes only in transport, and
 * this file is that place.** `errors` deliberately holds no status codes; the
 * mapping lives here and nowhere else, so there is exactly one answer to *what
 * status is a conflict* in the whole process.
 *
 * See `notes/patterns/httpx.md`.
 */

import { AppError, Kind, kindOf, type FieldIssue } from '../errors/index.js';

/** Conformance case 3. The whole table, in one place. */
const STATUS: Readonly<Record<Kind, number>> = {
  [Kind.Invalid]: 400,
  // Understood, and refused. Distinct from 400 by decision 0010, and the
  // distinction is the one HTTP draws.
  [Kind.Unprocessable]: 422,
  [Kind.Unauthenticated]: 401,
  [Kind.Forbidden]: 403,
  [Kind.NotFound]: 404,
  [Kind.Conflict]: 409,
  // Case 29. Proposed rather than settled — see ADR 0011 — but the mapping is
  // not in doubt: RFC 9110 §15.5.13 names 412 for exactly this.
  [Kind.PreconditionFailed]: 412,
  // `exhausted` is this collection's name for rate limited.
  [Kind.Exhausted]: 429,
  [Kind.Unavailable]: 503,
  [Kind.Timeout]: 504,
  // A caller that hung up. 499 is nginx's, not an RFC's, and it is the only
  // honest code for "nobody is listening any more".
  [Kind.Canceled]: 499,
  [Kind.Internal]: 500,
};

/**
 * **Total, by construction.** `Record<Kind, number>` means adding a `Kind`
 * without adding a status does not compile — which is the property collection
 * decision 0010 chose a new `Kind` over a status-on-the-error to keep.
 *
 * This file briefly carried the other design: an `Invalid` error with an
 * `unprocessable` marker in `details`, read here. It worked, and it was wrong
 * for the reason 0010 gives — a status a caller can attach to an error makes
 * this table advisory rather than total, and "mapped in exactly one place"
 * becomes a convention instead of a property. ADR 0009 records the local
 * decision; 0010 supersedes it with a better answer than the one asked for.
 */
export function statusFor(kind: Kind): number {
  return STATUS[kind];
}

/** RFC 9457 §3.1. `type` is a URI reference; a relative one is legal. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  /** Correlates the body with the log line, on every response. */
  readonly instance?: string;
  /**
   * Field path → messages.
   *
   * **Every problem at once** (case 2), never the first failure alone: a caller
   * fixing one field per round trip is the same waste `env` refuses at boot.
   */
  readonly errors?: Readonly<Record<string, readonly string[]>>;
}

const TITLES: Readonly<Record<Kind, string>> = {
  [Kind.Invalid]: 'Invalid request',
  [Kind.Unprocessable]: 'Unprocessable request',
  [Kind.Unauthenticated]: 'Authentication required',
  [Kind.Forbidden]: 'Not permitted',
  [Kind.NotFound]: 'Not found',
  [Kind.Conflict]: 'Conflict',
  [Kind.PreconditionFailed]: 'Precondition failed',
  [Kind.Exhausted]: 'Too many requests',
  [Kind.Unavailable]: 'Service unavailable',
  [Kind.Timeout]: 'Timed out',
  [Kind.Canceled]: 'Client closed request',
  [Kind.Internal]: 'Internal error',
};

/**
 * What a client is told.
 *
 * **A 5xx detail is generic.** The message on an internal error names an
 * implementation — a table, a host, a driver — and the caller can do nothing
 * with it. The `instance` is what turns a support conversation into a log
 * search, which is why it is on every problem rather than only on failures a
 * caller can act on.
 */
function detailFor(error: unknown, kind: Kind): string {
  if (kind === Kind.Internal || kind === Kind.Unavailable) {
    return 'The request could not be completed.';
  }
  return error instanceof Error ? error.message : String(error);
}

function fieldErrors(
  issues: readonly FieldIssue[],
): Record<string, string[]> | undefined {
  if (issues.length === 0) return undefined;

  const map: Record<string, string[]> = {};
  for (const issue of issues) {
    (map[issue.field] ??= []).push(issue.message);
  }
  return map;
}

/**
 * A typed error as a problem.
 *
 * **Renders from the `Kind`, never from a payload something else handed us**
 * (case 4). An upstream body is attacker-influenced on some paths and noise on
 * all of them, and `httpclient` has already refused to put one in a message —
 * this is the second half of that promise.
 */
export function problemFor(error: unknown, instance?: string): Problem {
  const kind = kindOf(error);
  const status = statusFor(kind);
  const issues = error instanceof AppError ? error.fields : [];
  const errors = fieldErrors(issues);

  return {
    // A relative URI reference, so it works before anything is published and
    // stays stable if the docs move.
    type: `/problems/${kind}`,
    title: TITLES[kind],
    status,
    detail: detailFor(error, kind),
    ...(instance === undefined ? {} : { instance }),
    ...(errors === undefined ? {} : { errors }),
  };
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
