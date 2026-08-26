/**
 * A role **inside an organization**. **`orgs` domain.**
 *
 * `CONTEXTS.md` §4, and this is the reason `orgs` is in the constant set: a
 * user belongs to several organizations with a different role in each, so
 * authorization reads their role *in the organization the resource belongs to*
 * — never a flat account role.
 *
 * **The distinction from an account role is not cosmetic.** `identity` has
 * `admin`, `auditor`, `member`, and they say what somebody may do to the
 * *system*. These say what somebody may do inside **one** organization, and the
 * same person is an owner of theirs and a member of yours. A single flat set
 * cannot express that, which is what §4 means by *without it, `authz` gets
 * modelled wrong*.
 *
 * Closed, and ordered: every comparison below is *at least this role*, and an
 * open set has no such comparison.
 */

import { invalid } from '../../../shared/errors/index.js';

export const OrgRole = {
  /** Founds, archives, and is the one role an organization must always have. */
  Owner: 'owner',
  /** Manages the roster. Cannot archive, cannot remove the last owner. */
  Admin: 'admin',
  /** Belongs, and can see the organization. */
  Member: 'member',
} as const;

export type OrgRole = (typeof OrgRole)[keyof typeof OrgRole];

/** Ascending authority. The index **is** the comparison. */
const ORDER: readonly OrgRole[] = [
  OrgRole.Member,
  OrgRole.Admin,
  OrgRole.Owner,
];

export function orgRole(raw: string): OrgRole {
  const found = ORDER.find((role) => role === raw);
  if (found === undefined) {
    throw invalid(`not an organization role: ${raw}`, [
      { field: 'role', message: 'is not owner, admin or member' },
    ]);
  }
  return found;
}

/**
 * Is `held` at least `needed`?
 *
 * A comparison rather than a set membership test, because the alternative is a
 * table of which roles imply which — and the table is the thing that gets a row
 * wrong the day a fourth role is added.
 */
export function atLeast(held: OrgRole, needed: OrgRole): boolean {
  return ORDER.indexOf(held) >= ORDER.indexOf(needed);
}
