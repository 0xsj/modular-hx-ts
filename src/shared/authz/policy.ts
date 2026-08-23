/**
 * Policy is data, owned by the composition root. **L3 capability.**
 *
 * **Contexts name permissions; the root holds the mapping.** `authz` does not
 * know what a user is — it knows subjects, actions and resources. That is what
 * keeps it L3 and domain-free while `identity` is a context.
 *
 * **Validated at boot**, so a typo is a startup failure rather than a silent
 * denial discovered six months later by the one person who needed that
 * endpoint.
 *
 * See `notes/patterns/authz.md`.
 */

import { invalid, type FieldIssue } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { type Action, isAction } from './subject.js';

/**
 * How far a grant reaches.
 *
 * **`own` and `any` are the same action with different scope**, deliberately
 * not two action names. *Your own audit records* and *every audit record* are
 * one permission at two reaches, and splitting them into `audit:read` and
 * `audit:read_all` is how the two drift apart — one gets a new condition, the
 * other does not, and nobody notices until an auditor asks.
 */
export const Scope = {
  /** Only resources the subject owns. */
  Own: 'own',
  /** Every resource in the subject's tenant. */
  Any: 'any',
} as const;

export type Scope = (typeof Scope)[keyof typeof Scope];

export interface Grant {
  readonly action: Action;
  readonly scope: Scope;
}

/** `role -> grants`. The one policy, held by the root. */
export type PolicySpec = Readonly<Record<string, readonly Grant[]>>;

export interface Policy {
  /** The widest scope this set of roles has for `action`, or `undefined`. */
  scopeFor(roles: readonly string[], action: Action): Scope | undefined;
  roles(): readonly string[];
  actions(): readonly Action[];
}

/**
 * Compile a policy, or say everything wrong with it.
 *
 * `knownActions` is the set contexts have declared. A grant naming an action
 * nobody implements is a typo that would otherwise present as a permission
 * that simply never applies — the hardest kind to notice, because the endpoint
 * denies and everyone assumes that is the intent.
 */
export function compilePolicy(
  spec: PolicySpec,
  knownActions?: readonly Action[],
): Result<Policy> {
  const issues: FieldIssue[] = [];
  const known = knownActions === undefined ? undefined : new Set(knownActions);
  const byRole = new Map<string, Map<Action, Scope>>();

  for (const [role, grants] of Object.entries(spec)) {
    if (role === '') {
      issues.push({ field: 'roles', message: 'a role is named' });
      continue;
    }

    const compiled = new Map<Action, Scope>();
    for (const grant of grants) {
      if (!isAction(grant.action)) {
        issues.push({
          field: `${role}.${grant.action}`,
          message: 'is not <resource>:<verb> with lowercase segments',
        });
        continue;
      }
      if (known !== undefined && !known.has(grant.action)) {
        issues.push({
          field: `${role}.${grant.action}`,
          message: 'names an action no context declares',
        });
        continue;
      }

      // The widest wins: a role granted both `own` and `any` has `any`. Two
      // rows saying different things is a policy-authoring mistake rather than
      // a narrowing, and silently taking the narrower one would deny requests
      // the author believed were allowed.
      const existing = compiled.get(grant.action);
      compiled.set(
        grant.action,
        existing === Scope.Any || grant.scope === Scope.Any
          ? Scope.Any
          : Scope.Own,
      );
    }
    byRole.set(role, compiled);
  }

  if (issues.length > 0) {
    return err(invalid('the policy cannot be compiled', issues));
  }

  return ok({
    scopeFor(roles, action) {
      let widest: Scope | undefined;
      for (const role of roles) {
        const scope = byRole.get(role)?.get(action);
        if (scope === Scope.Any) return Scope.Any;
        if (scope === Scope.Own) widest = Scope.Own;
      }
      return widest;
    },

    roles: () => [...byRole.keys()].sort(),

    actions: () =>
      [...new Set([...byRole.values()].flatMap((m) => [...m.keys()]))].sort(),
  });
}
