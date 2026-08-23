/**
 * Tenancy. **L3 capability.**
 *
 * **Single mode is byte-identical to no tenancy** — one seeded tenant, zero
 * lookups, behaviour indistinguishable from a build that never heard of
 * tenants (conformance case 21). That is what makes carrying this from day one
 * free, and it is why adding it later touches every query, every envelope,
 * every audit row and every cache key at once.
 *
 * **Resolution happens before authentication** — header or host subdomain,
 * checked against the registry, unknown 404 and suspended 403 (case 22).
 * Resolving after auth evaluates a credential from tenant A in tenant B's
 * context before anyone notices.
 *
 * **The fence beats every grant, including an administrator's** (case 24). It
 * runs before grants are consulted rather than being one, because a fence that
 * is merely the most powerful grant is a fence somebody can out-grant.
 *
 * **A cross-tenant resource is invisible, not forbidden** — 404, never 403
 * (case 23). A 403 confirms existence, which turns any id into an oracle for
 * what other tenants hold.
 *
 * Note: `notes/patterns/tenant.md`.
 */

export {
  DEFAULT_TENANT,
  Status,
  Tenancy,
  type Tenant,
  tenant,
} from './tenant.js';

export {
  type Inbound,
  type Registry,
  type Resolver,
  type ResolverOptions,
  invisible,
  makeResolver,
  requireTenant,
  subdomainOf,
} from './registry.js';

export { type MemoryRegistry, memoryRegistry } from './memory.js';

export {
  TENANT_TABLE,
  postgresRegistry,
  tenantMigrations,
} from './postgres.js';

export { type Fenced, fence } from './fence.js';
