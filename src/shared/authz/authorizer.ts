/**
 * The decision. **L3 capability.**
 *
 * **Deny by default, structurally rather than by convention.** An action with
 * no matching grant is denied, and an authorizer that was never wired is
 * `denyAll` rather than `allowAll`. A forgotten wire shows up as 403s in the
 * first test, never as an open admin endpoint.
 *
 * This is the reference case for invariant `I9`'s fail-closed column: security
 * controls fail closed, availability controls fail open, and the choice is
 * visible in code rather than implied.
 *
 * See `notes/patterns/authz.md`.
 */

import { forbidden, type AppError } from '../errors/index.js';
import { type Policy, Scope } from './policy.js';
import {
  type Action,
  type Resource,
  type Subject,
  subjectId,
} from './subject.js';

/**
 * Why a request was refused.
 *
 * Deliberately coarse. A denial that explained *which* grant was missing would
 * be an enumeration oracle, and the caller can do nothing with the detail
 * anyway.
 */
export type Denial = 'no_grant' | 'not_owner' | 'out_of_scope' | 'no_policy';

export type Decision =
  | { readonly allowed: true; readonly scope: Scope }
  | { readonly allowed: false; readonly reason: Denial };

const deny = (reason: Denial): Decision => ({ allowed: false, reason });

/**
 * A pre-resource decision.
 *
 * `unrestricted` sees the whole tenant, `own` sees only the subject's own, and
 * `denied` sees nothing. The tri-state is common enough — every list endpoint
 * needs it before it builds a query — that it belongs here rather than being
 * written slightly differently in each context.
 */
export type Reach = 'unrestricted' | 'own' | 'denied';

export interface Authorizer {
  /**
   * May this subject perform this action on this resource?
   *
   * `resource` is optional so a caller can ask about an action before it has
   * one — creating, or listing. Without a resource an `own`-scoped grant is
   * *allowed with scope `own`*, and it is the caller's job to narrow the query;
   * `reach` exists so it does not have to interpret that itself.
   */
  allow(subject: Subject, action: Action, resource?: Resource): Decision;

  /** The tri-state, for a caller about to build a query. */
  reach(subject: Subject, action: Action): Reach;
}

/**
 * The authorizer used when none was wired.
 *
 * **Not a placeholder to be replaced later — the safe default.** Exported so a
 * test can be explicit about it, and so nothing has to invent an
 * `allowAll` to stand in.
 */
export const denyAll: Authorizer = {
  allow: () => deny('no_policy'),
  reach: () => 'denied',
};

export interface AuthorizerOptions {
  /**
   * Runs **before** grants are consulted, and a `false` denies outright.
   *
   * Empty today. `tenant` lands next and its fence **beats every grant,
   * including an administrator's** — a cross-tenant resource is invisible, not
   * forbidden. The hook exists so that lands as a wiring change rather than a
   * restructuring: nothing here assumes grants are the first thing examined.
   */
  readonly before?: (
    subject: Subject,
    action: Action,
    resource?: Resource,
  ) => boolean;
}

export function makeAuthorizer(
  policy: Policy,
  options: AuthorizerOptions = {},
): Authorizer {
  /**
   * The subject's scope for an action, after scopes have subtracted.
   *
   * **Scopes only ever subtract.** When a subject carries scopes — an API key —
   * the effective permission is the **intersection** of its scopes and its
   * owner's grants. A leaked key must not be able to exceed the human it
   * belongs to, so this is evaluated as *grant first, then narrowed*, never as
   * a union.
   */
  const effectiveScope = (
    subject: Subject,
    action: Action,
  ): Scope | undefined => {
    const granted = policy.scopeFor(subject.roles, action);
    if (granted === undefined) return undefined;

    const scopes = subject.scopes;
    // No scopes at all is a person, not an unscoped key: the owner's grants
    // apply unchanged.
    if (scopes === undefined) return granted;

    // An empty scope list is a key that may do nothing. Treating it as "no
    // restriction" is the inversion that turns a locked-down key into a
    // superuser.
    return scopes.includes(action) ? granted : undefined;
  };

  return {
    allow(subject, action, resource) {
      // Before grants, deliberately. See `AuthorizerOptions.before`.
      if (options.before?.(subject, action, resource) === false) {
        return deny('out_of_scope');
      }

      const scope = effectiveScope(subject, action);
      // An unknown action reaches here with no grant and is denied — not an
      // error. A typo in a call site must not be distinguishable from a
      // permission the caller genuinely lacks.
      if (scope === undefined) return deny('no_grant');

      if (scope === Scope.Any) return { allowed: true, scope };

      // `own`, and there is something to compare against.
      if (resource === undefined) return { allowed: true, scope };

      const owner = resource.ownerId;
      // An unowned resource is one an `own`-scoped grant cannot reach. Absent
      // is not "mine".
      if (owner === undefined || owner !== subjectId(subject)) {
        return deny('not_owner');
      }

      return { allowed: true, scope };
    },

    reach(subject, action) {
      if (options.before?.(subject, action) === false) return 'denied';

      const scope = effectiveScope(subject, action);
      if (scope === undefined) return 'denied';
      return scope === Scope.Any ? 'unrestricted' : 'own';
    },
  };
}

/**
 * The decision as an error, for a caller that wants to throw.
 *
 * `Forbidden` rather than `NotFound`: hiding existence is `tenant`'s job and it
 * is a different question from permission. Conflating them here would make the
 * fence's behaviour impossible to distinguish from an ordinary denial.
 */
export function refusal(action: Action, decision: Decision): AppError {
  return forbidden(`not permitted: ${action}`, {
    details: {
      action,
      reason: decision.allowed ? 'allowed' : decision.reason,
    },
  });
}
