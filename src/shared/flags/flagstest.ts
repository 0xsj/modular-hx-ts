/**
 * One contract suite; every provider passes it. **Test tooling** — rule `S3`.
 *
 * The providers differ in *when* a change is visible — `static` never changes,
 * `file` and `postgres` after a TTL — so what they share is **how a flag is
 * decided**, not how it arrives. Freshness is asserted per provider, where the
 * promise differs.
 */

import { describe, expect, it } from 'vitest';
import { type Flags } from './port.js';
import { Status, type Flag } from './rule.js';

export interface Subject {
  readonly name: string;
  /** Flags built over this provider, seeded with `SEED`. */
  readonly flags: () => Promise<Flags>;
}

/** The seed every provider is given. */
export const SEED: readonly Flag[] = [
  {
    key: 'checkout.new_flow',
    fallback: 'off',
    rules: [
      { name: 'acme', when: { tenants: ['t_acme'] }, value: 'on' },
      {
        name: 'pro-plan',
        when: { attributes: { plan: ['pro'] } },
        value: 'on',
      },
    ],
  },
  {
    key: 'search.ranking',
    fallback: 'classic',
    rules: [{ name: 'beta', when: { actors: ['u_ada'] }, value: 'semantic' }],
  },
  {
    key: 'billing.always_off',
    fallback: 'off',
    rules: [],
  },
  {
    key: 'ui.narrow_and',
    fallback: 'off',
    rules: [
      {
        name: 'both',
        // Two selectors on one rule: **AND**, not OR.
        when: { tenants: ['t_acme'], attributes: { plan: ['pro'] } },
        value: 'on',
      },
    ],
  },
];

export function flagsContract(subject: () => Subject): void {
  const flags = async (): Promise<Flags> => subject().flags();

  describe('an unknown key', () => {
    it('is off', async () => {
      // **A typo must disable a feature, never enable one.**
      const f = await flags();

      expect(f.enabled('checkout.new_flowe')).toBe(false);
      expect(f.enabled('nothing.at_all')).toBe(false);
    });

    it('is reported as unknown, not as a considered off', async () => {
      // So a misspelling is visible in a listing rather than looking like
      // somebody's deliberate decision.
      const f = await flags();

      expect(f.decide('checkout.new_flowe').status).toBe(Status.Unknown);
      // The flag that really is off says so differently.
      expect(f.decide('billing.always_off').status).toBe(Status.Fallback);
    });
  });

  describe('rules', () => {
    it('take the first match, in order', async () => {
      const f = await flags();

      // The `acme` rule is first and matches on tenant alone.
      expect(f.decide('checkout.new_flow', { tenant: 't_acme' }).rule).toBe(
        'acme',
      );
      // A different tenant falls to the second rule.
      expect(
        f.decide('checkout.new_flow', {
          tenant: 't_other',
          attributes: { plan: 'pro' },
        }).rule,
      ).toBe('pro-plan');
    });

    it('AND their selectors rather than OR-ing them', async () => {
      // Every present selector must match. The temptation is to read an
      // unmatched dimension as a wildcard, which turns AND into OR.
      const f = await flags();

      expect(f.enabled('ui.narrow_and', { tenant: 't_acme' })).toBe(false);
      expect(f.enabled('ui.narrow_and', { attributes: { plan: 'pro' } })).toBe(
        false,
      );
      expect(
        f.enabled('ui.narrow_and', {
          tenant: 't_acme',
          attributes: { plan: 'pro' },
        }),
      ).toBe(true);
    });

    it('falls back when nothing matches', async () => {
      const f = await flags();
      const decision = f.decide('search.ranking', { actor: 'u_grace' });

      expect(decision.value).toBe('classic');
      expect(decision.status).toBe(Status.Fallback);
      expect(decision.rule).toBeUndefined();
    });

    it('returns a variant, not only a boolean', async () => {
      const f = await flags();

      expect(f.variant('search.ranking', { actor: 'u_ada' })).toBe('semantic');
      expect(f.variant('search.ranking', { actor: 'u_grace' })).toBe('classic');
    });

    it('explains every flag for a scope', async () => {
      // What a debug endpoint returns, and what makes a rollout reviewable.
      const f = await flags();
      const explained = f.explain({ tenant: 't_acme' });

      expect(explained.map((d) => d.key).sort()).toEqual([
        'billing.always_off',
        'checkout.new_flow',
        'search.ranking',
        'ui.narrow_and',
      ]);
      expect(explained.find((d) => d.key === 'checkout.new_flow')?.value).toBe(
        'on',
      );
    });
  });
}
