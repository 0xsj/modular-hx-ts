/**
 * `Role`. **`identity` domain.**
 *
 * **Identity records *which* roles a user holds. It does not know what any of
 * them permit** — that is the composition root's policy, compiled by `authz`.
 * The separation is what lets a role be granted here and interpreted there
 * without this context importing a policy it would then have to keep in step.
 *
 * See `notes/domain/identity.md`.
 */

import { invalid } from '../../../shared/errors/index.js';

declare const tag: unique symbol;
export type Role = string & { readonly [tag]: 'Role' };

/** §2.1: lowercased, `[a-z][a-z0-9_-]{0,31}`. */
const SHAPE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Parse and normalize, or throw.
 *
 * Lowercased at construction, so `Admin` and `admin` cannot both be granted and
 * then compared unequal by a policy that saw only one of them.
 */
export function role(raw: string): Role {
  const normalized = raw.trim().toLowerCase();

  if (!SHAPE.test(normalized)) {
    throw invalid(`not a role: ${raw}`, [
      { field: 'role', message: 'is not a role' },
    ]);
  }
  return normalized as Role;
}

/**
 * Sorted, de-duplicated, and stable.
 *
 * The order a set of roles is written in is not information, so it is not
 * stored: a stable order keeps `User.Version` from bumping on a grant that
 * changed nothing, and keeps the ETag over a user's representation stable
 * across a round trip.
 */
export function normalizeRoles(roles: readonly Role[]): readonly Role[] {
  return [...new Set(roles)].sort();
}
