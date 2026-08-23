/**
 * What a tenant is, and the mode the process runs in. **L3 capability.**
 *
 * **Single mode is byte-identical to no tenancy.** One seeded tenant, zero
 * lookups, and behaviour indistinguishable from a build that never heard of
 * tenants — conformance case 21, and the headline property rather than a
 * footnote.
 *
 * That is what makes carrying this from day one *free*, and it is the whole
 * argument for doing so: adding tenancy later touches every query in every
 * repository, every event envelope, every audit row and every cache key **at
 * once**.
 *
 * See `notes/patterns/tenant.md`.
 */

import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/**
 * How this process treats tenancy.
 *
 * `single` is not a degraded `multi`. It is the absence of tenancy, reached by
 * a path that keeps the code identical.
 */
export const Tenancy = {
  Single: 'single',
  Multi: 'multi',
} as const;

export type Tenancy = (typeof Tenancy)[keyof typeof Tenancy];

export const Status = {
  Active: 'active',
  /** Exists, and may not be used. **403**, not 404 — it is not a secret. */
  Suspended: 'suspended',
} as const;

export type Status = (typeof Status)[keyof typeof Status];

export interface Tenant {
  readonly id: string;
  /** The subdomain or header value that resolves to it. */
  readonly slug: string;
  readonly name: string;
  readonly status: Status;
}

/**
 * The one tenant a `single`-mode process has.
 *
 * A real tenant with a real id, not a `null` threaded through every call site.
 * That is precisely what keeps single mode byte-identical: the code path is the
 * multi-tenant one, with a lookup that cannot fail.
 */
export const DEFAULT_TENANT: Tenant = {
  id: 'default',
  slug: 'default',
  name: 'Default',
  status: Status.Active,
};

/**
 * `PROVENANCE.md` §7: `tenant` is an id, and ids share one shape across the
 * collection. §2 makes it **L3's obligation to mint ids that satisfy a rule
 * owned by L1** — so it is checked here, where tenants are created.
 */
const ID = /^[A-Za-z0-9._:/-]{1,128}$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function tenant(candidate: Tenant): Result<Tenant> {
  if (!ID.test(candidate.id)) {
    return err(invalid(`tenant id is not a provenance id: ${candidate.id}`));
  }
  // A slug reaches a hostname, so it is bound by DNS label rules rather than
  // by ours.
  if (!SLUG.test(candidate.slug)) {
    return err(invalid(`tenant slug is not a DNS label: ${candidate.slug}`));
  }
  return ok(candidate);
}
