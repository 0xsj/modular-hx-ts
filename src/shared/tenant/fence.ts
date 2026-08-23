/**
 * The fence. **L3 capability.**
 *
 * **It beats every grant, including an administrator's.** The tenant check runs
 * *before* grants are consulted — it is not another grant, and that distinction
 * is the module.
 *
 * A fence that were merely the most powerful grant is a fence somebody can
 * out-grant: one policy edit, one new role, one `*` in the wrong place, and the
 * boundary is gone with no code change and no review that looked like a
 * security change. Running first means no policy can express crossing it.
 *
 * `authz` left `AuthorizerOptions.before` open for exactly this, so this lands
 * as a wiring change rather than a restructuring.
 *
 * See `notes/patterns/tenant.md`.
 */

import { type Resource, type Subject } from '../authz/index.js';

/**
 * A resource's tenant, when it has one.
 *
 * `Resource` is `authz`'s type and deliberately knows nothing about tenancy, so
 * the owning tenant travels as an optional field a repository fills in. A
 * resource with none is not fenced — it is not tenant-owned.
 */
export interface Fenced extends Resource {
  readonly tenant?: string;
}

/**
 * The `before` hook: `false` denies outright, ahead of any grant lookup.
 *
 * Only compares when the resource states a tenant. A pre-resource question —
 * *may this subject list users at all?* — is not a fence question, and denying
 * it here would make every list endpoint fail before `reach` could narrow it.
 */
export function fence(
  subject: Subject,
  _action: string,
  resource?: Resource,
): boolean {
  const owner = (resource as Fenced | undefined)?.tenant;
  if (owner === undefined) return true;
  return owner === subject.tenant;
}
