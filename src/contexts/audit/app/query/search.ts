/**
 * Reading the log. **`audit` app · query.** Conformance case 37.
 *
 * **This is where `authz` is exercised across a context boundary for the first
 * time.** The composition root lends `audit` identity's bearer auth and hands
 * the caller over as an authz `Subject` (§3) — so a subject minted by one
 * context authorizes a read in another, which is the whole point of `Subject`
 * being a shared type rather than each context's own.
 *
 * See `notes/domain/audit.md`.
 */

import {
  type Authorizer,
  type Subject,
  subjectId,
} from '../../../../shared/authz/index.js';
import { forbidden } from '../../../../shared/errors/index.js';
import {
  type AuditQuery,
  type AuditRecord,
  type Scope,
  auditQuery,
} from '../../domain/index.js';
import { type AuditLog } from '../ports.js';

export interface SearchDeps {
  readonly log: AuditLog;
  readonly authorizer: Authorizer;
}

/**
 * `audit`'s one permission.
 *
 * `type:verb`, and the type matches the resource's. The *permission* is this
 * context's vocabulary; what it **grants** is the root's policy — which is what
 * lets `admin` and `auditor` read everything without `audit` knowing either
 * name exists.
 */
export const READ_RECORDS = 'audit_record:read';

/**
 * Turn a decision into a scope.
 *
 * **`reach` rather than `allow`**, because the caller has no resource yet — it
 * is about to build a query, and `authz` exposes the tri-state for exactly this
 * so every list endpoint does not interpret `own` slightly differently.
 */
export function scopeFor(authorizer: Authorizer, subject: Subject): Scope {
  switch (authorizer.reach(subject, READ_RECORDS)) {
    case 'unrestricted':
      // `admin` and `auditor`, per §3 — named in the root's policy, never here.
      return { kind: 'all' };
    case 'own':
      // **Actor *or* subject.** Two different sets, and a caller needs both:
      // being disabled by an administrator is a record where somebody else is
      // the actor, and it is the one you most want to find.
      return {
        kind: 'own',
        id: subjectId(subject),
        actor: subject.actor.toString(),
      };
    case 'denied':
      return { kind: 'none' };
  }
}

export async function searchRecords(
  deps: SearchDeps,
  subject: Subject,
  raw: AuditQuery,
): Promise<readonly AuditRecord[]> {
  const scope = scopeFor(deps.authorizer, subject);

  if (scope.kind === 'none') {
    // Deny by default — case 18. `denyAll` is the authorizer when the root
    // wires none, so an unwired policy reads nothing rather than everything.
    throw forbidden('not permitted to read audit records');
  }

  // **Validated after the scope, applied before the store.** A caller cannot
  // widen their reach with a filter, because the scope is a separate argument
  // the adapter ANDs in rather than a default the query could override.
  return deps.log.search(auditQuery(raw), scope);
}
