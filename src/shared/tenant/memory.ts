/**
 * The in-process registry. **The `STORAGE=memory` adapter.**
 *
 * Seeded, because a `single`-mode process still needs its one tenant to exist —
 * that is what keeps the code path identical to the multi-tenant one.
 *
 * See `notes/patterns/tenant.md`.
 */

import { unwrap } from '../result/index.js';
import { type Registry } from './registry.js';
import { DEFAULT_TENANT, tenant as validate, type Tenant } from './tenant.js';

export interface MemoryRegistry extends Registry {
  add(candidate: Tenant): MemoryRegistry;
}

export function memoryRegistry(
  seed: readonly Tenant[] = [DEFAULT_TENANT],
): MemoryRegistry {
  const byId = new Map<string, Tenant>();
  const bySlug = new Map<string, Tenant>();

  const registry: MemoryRegistry = {
    add(candidate) {
      const checked = unwrap(validate(candidate));
      byId.set(checked.id, checked);
      bySlug.set(checked.slug, checked);
      return registry;
    },
    byId: (id) => Promise.resolve(byId.get(id)),
    bySlug: (slug) => Promise.resolve(bySlug.get(slug)),
    all: () => Promise.resolve([...byId.values()]),
  };

  for (const one of seed) registry.add(one);
  return registry;
}
