/**
 * What may be asked of the log. **`audit` domain.**
 *
 * §3: queryable by actor, subject, event, **event prefix**, correlation and
 * time. A value object rather than six parameters, because the *scope* below is
 * applied to the same structure and a caller must not be able to build a filter
 * the scope cannot narrow.
 *
 * See `notes/domain/audit.md`.
 */

import { invalid } from '../../../shared/errors/index.js';

export interface AuditQuery {
  readonly actor?: string | undefined;
  readonly subject?: string | undefined;
  /** An exact event name — `identity.user.registered`. */
  readonly event?: string | undefined;
  /**
   * A prefix — `identity.` or `identity.user.`.
   *
   * **Dots are the boundary** (§2.5), which is why the name is dot-separated in
   * the first place. `identity.user.` matches `identity.user.registered` and
   * not `identity.session.created`, and neither matches a hypothetical
   * `identityx.`.
   */
  readonly prefix?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly since?: Date | undefined;
  readonly until?: Date | undefined;
  readonly limit?: number | undefined;
}

/** The most a single page returns, so a filter cannot become an export. */
export const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function auditQuery(raw: AuditQuery): AuditQuery {
  const limit = raw.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw invalid(`a limit is 1-${String(MAX_LIMIT)}`, [
      { field: 'limit', message: `must be 1-${String(MAX_LIMIT)}` },
    ]);
  }

  if (
    raw.prefix !== undefined &&
    !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.?$/.test(raw.prefix)
  ) {
    // A prefix goes into a `like` pattern downstream, and `%` or `_` in it
    // would turn a filter into a scan of everything. Validated here so the
    // adapter can escape a value it already knows the shape of.
    throw invalid('not an event prefix', [
      { field: 'prefix', message: 'is not an event prefix' },
    ]);
  }

  if (
    raw.since !== undefined &&
    raw.until !== undefined &&
    raw.since.getTime() > raw.until.getTime()
  ) {
    throw invalid('the window ends before it begins', [
      { field: 'until', message: 'is before `since`' },
    ]);
  }

  return { ...raw, limit };
}

/**
 * How much of the log a caller may see — conformance case 37.
 *
 * `all` is `admin` and `auditor`. `own` is everybody else, and it means
 * **actor *or* subject**: you see what you did, and you see what was done to
 * you. Those are two different sets and a caller needs both — being disabled by
 * an administrator is a record where you are the subject and somebody else is
 * the actor, and it is the record you most want to find.
 */
export type Scope =
  | { readonly kind: 'all' }
  | {
      readonly kind: 'own';
      /** The subject id, as a payload names it — a bare user id. */
      readonly id: string;
      /**
       * The **actor string**, as an envelope names it — `user:<id>`.
       *
       * Two fields rather than one, because the two halves of *actor or
       * subject* are spelled differently in a record and comparing one value
       * against both was silently a comparison against one. Every test passed
       * because `identity`'s events name the acting user as their payload
       * subject too — so the actor half had never matched anything, and it
       * took an `orgs` event whose subject is an **organization** to notice.
       */
      readonly actor: string;
    }
  | { readonly kind: 'none' };
