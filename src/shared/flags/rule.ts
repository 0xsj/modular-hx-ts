/**
 * Rules, not a DSL. **L3 capability.**
 *
 * A rule is a set of selectors **ANDed** together, with a value. First match
 * wins, evaluated in order.
 *
 * **The temptation is an expression language.** The cost is that nobody can
 * reason about what is enabled for whom — and a flag nobody can reason about is
 * worse than a deploy, because a deploy is at least reviewable and reversible
 * by a mechanism everybody already understands.
 *
 * If a rule needs boolean logic beyond AND, **that is two rules**. `a AND (b OR
 * c)` is two rules with the same value, in order, and the flattening is the
 * point: the list reads top to bottom and the first match wins.
 *
 * See `notes/patterns/flags.md`.
 */

import { invalid, type FieldIssue } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { BUCKETS, inCohort } from './cohort.js';

/** `checkout.new-flow`, `identity.passkeys`. */
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function isFlagKey(value: string): boolean {
  return KEY.test(value);
}

/**
 * Who a rule applies to. **Every present selector must match.**
 *
 * An absent selector is not a wildcard that matches anything — it is a
 * dimension this rule does not care about. That reads the same and is worth
 * saying, because the alternative reading makes an empty rule match nothing
 * rather than everything.
 */
export interface Selector {
  readonly tenants?: readonly string[];
  readonly actors?: readonly string[];
  /** Exact matches on caller-supplied attributes — `plan: ['pro']`. */
  readonly attributes?: Readonly<Record<string, readonly string[]>>;
  /**
   * A sticky rollout, 0–100.
   *
   * Evaluated **last** among the selectors, because it is the only one that
   * hashes — so a rule excluded on tenant never pays for it.
   */
  readonly percentage?: number;
}

export interface Rule {
  readonly when: Selector;
  /** `'on'` / `'off'` for a boolean flag, or a variant name. */
  readonly value: string;
  /** Names this rule in a span and in a listing. */
  readonly name?: string;
}

export interface Flag {
  readonly key: string;
  /** Used when no rule matches. */
  readonly fallback: string;
  readonly rules: readonly Rule[];
  readonly description?: string;
}

/** What a caller knows about the request, beyond tenant and actor. */
export interface Scope {
  readonly tenant?: string;
  readonly actor?: string;
  readonly attributes?: Readonly<Record<string, string>>;
  /**
   * What a percentage rollout is sticky on.
   *
   * The actor by default. A caller may override it — bucketing an anonymous
   * visitor on a device id, say — but it must be **stable for that subject**,
   * or the cohort is a coin flip per request.
   */
  readonly subject?: string;
}

export const Status = {
  /** A rule matched. */
  Matched: 'matched',
  /** The flag exists and no rule matched. */
  Fallback: 'fallback',
  /**
   * No such flag.
   *
   * **Distinguishable from a flag that is present and off**, deliberately, so a
   * misspelling is visible in a listing rather than looking like a considered
   * decision.
   */
  Unknown: 'unknown',
} as const;

export type Status = (typeof Status)[keyof typeof Status];

export interface Decision {
  readonly key: string;
  readonly value: string;
  readonly status: Status;
  /** Which rule matched, when one did. */
  readonly rule?: string;
}

/** Does every present selector match? */
function matches(
  selector: Selector,
  key: string,
  scope: Scope,
): Result<boolean> {
  if (
    selector.tenants !== undefined &&
    (scope.tenant === undefined || !selector.tenants.includes(scope.tenant))
  ) {
    return ok(false);
  }

  if (
    selector.actors !== undefined &&
    (scope.actor === undefined || !selector.actors.includes(scope.actor))
  ) {
    return ok(false);
  }

  for (const [name, allowed] of Object.entries(selector.attributes ?? {})) {
    const supplied = scope.attributes?.[name];
    if (supplied === undefined || !allowed.includes(supplied)) return ok(false);
  }

  if (selector.percentage !== undefined) {
    // Last, because it is the only selector that hashes.
    const subject = scope.subject ?? scope.actor;
    // A rollout with nobody to be sticky on cannot be sticky. Excluding is the
    // safe direction: an anonymous caller does not silently join every cohort.
    if (subject === undefined) return ok(false);
    return inCohort(key, subject, selector.percentage);
  }

  return ok(true);
}

/**
 * Evaluate a flag. **First match wins, in order.**
 *
 * A failure inside a rule — an unusable percentage, a key containing the
 * separator — is treated as *not matching* rather than propagated: a broken
 * rule must not take out the flag, and `validate` catches these at boot anyway.
 */
export function evaluate(flag: Flag, scope: Scope): Decision {
  for (const rule of flag.rules) {
    const hit = matches(rule.when, flag.key, scope);
    if (!hit.ok || !hit.value) continue;

    return {
      key: flag.key,
      value: rule.value,
      status: Status.Matched,
      ...(rule.name === undefined ? {} : { rule: rule.name }),
    };
  }

  return { key: flag.key, value: flag.fallback, status: Status.Fallback };
}

/** Validate a flag set at boot, so a typo is a startup failure. */
export function validate(flags: readonly Flag[]): Result<readonly Flag[]> {
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();

  for (const flag of flags) {
    if (!isFlagKey(flag.key)) {
      issues.push({ field: flag.key, message: 'is not <area>.<name>' });
      continue;
    }
    if (seen.has(flag.key)) {
      issues.push({ field: flag.key, message: 'is defined twice' });
      continue;
    }
    seen.add(flag.key);

    flag.rules.forEach((rule, index) => {
      const percentage = rule.when.percentage;
      if (
        percentage !== undefined &&
        (!Number.isFinite(percentage) || percentage < 0 || percentage > 100)
      ) {
        issues.push({
          field: `${flag.key}.rules.${String(index)}`,
          message: `percentage is 0-100, not ${String(percentage)}`,
        });
      }
      if (rule.value === '') {
        issues.push({
          field: `${flag.key}.rules.${String(index)}`,
          message: 'has no value',
        });
      }
    });
  }

  return issues.length === 0
    ? ok(flags)
    : err(invalid('the flag set cannot be compiled', issues));
}

export { BUCKETS };
