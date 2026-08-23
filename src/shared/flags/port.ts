/**
 * The flags port. **L3 capability.**
 *
 * **What this module is for, precisely:** config is read once at boot and
 * changing it needs a restart. A flag is read **per request** and changes
 * without one.
 *
 * That difference is the entire justification. If a value never needs to change
 * while the process runs, it belongs in `env` and not here — and putting it here
 * costs a lookup, a provider, a cache and a TTL for nothing.
 *
 * See `notes/patterns/flags.md`.
 */

import { Carrier } from '../provenance/index.js';
import { type Telemetry } from '../telemetry/index.js';
import {
  type Decision,
  type Flag,
  Status,
  evaluate,
  type Scope,
} from './rule.js';

/** Where flags come from. Three providers, one contract suite. */
export interface Source {
  get(key: string): Flag | undefined;
  all(): readonly Flag[];
  /** Refresh, where that means anything. A no-op for `static`. */
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface Flags {
  enabled(key: string, scope?: Scope): boolean;
  variant(key: string, scope?: Scope): string;
  /** The whole decision, for a listing and for an operator. */
  decide(key: string, scope?: Scope): Decision;
  /** Every flag, decided for this scope. What a debug endpoint returns. */
  explain(scope?: Scope): readonly Decision[];
}

export interface FlagsOptions {
  readonly source: Source;
  readonly telemetry: Telemetry;
  /** What `enabled` treats as true. */
  readonly truthy?: readonly string[];
}

export function makeFlags(options: FlagsOptions): Flags {
  const { source, telemetry } = options;
  const truthy = new Set(options.truthy ?? ['on', 'true', 'enabled']);

  /**
   * Tenant and actor from the **ambient carrier**.
   *
   * `flags` is an observer rather than a stamper — `../../../PROVENANCE.md` §3 —
   * so it reads what is already in scope and takes everything else explicitly.
   * A caller may still override either.
   */
  const resolve = (scope: Scope | undefined): Scope => {
    const provenance = Carrier.current();
    if (provenance === undefined) return scope ?? {};

    // Spread conditionally rather than assigning `undefined`, which
    // `exactOptionalPropertyTypes` refuses — and rightly, since an explicit
    // `tenant: undefined` in a scope would mean *no tenant* rather than
    // *unspecified*, and those select differently.
    return {
      ...(provenance.tenant === undefined ? {} : { tenant: provenance.tenant }),
      actor: provenance.actor.id,
      subject: provenance.actor.id,
      ...scope,
    };
  };

  const decide = (key: string, scope?: Scope): Decision => {
    const resolved = resolve(scope);
    const flag = source.get(key);

    // **An unknown key is off**, and reported as unknown rather than as a
    // considered `false` — so a typo is visible in a listing instead of looking
    // like somebody's decision.
    const decision: Decision =
      flag === undefined
        ? { key, value: 'off', status: Status.Unknown }
        : evaluate(flag, resolved);

    // **Every evaluation lands on the span.** A flag decision that is invisible
    // is a debugging session where nobody can explain the behaviour.
    const span = telemetry.tracer.start(`flag ${key}`);
    span.setAttribute('flag', key);
    span.setAttribute('value', decision.value);
    span.setAttribute('status', decision.status);
    if (decision.rule !== undefined) span.setAttribute('rule', decision.rule);
    span.end();

    return decision;
  };

  return {
    decide,
    enabled: (key, scope) => truthy.has(decide(key, scope).value),
    variant: (key, scope) => decide(key, scope).value,
    explain: (scope) => source.all().map((flag) => decide(flag.key, scope)),
  };
}
