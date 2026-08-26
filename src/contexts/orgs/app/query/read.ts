/**
 * Reads. **`orgs` app · query.**
 *
 * Every one of them is scoped by membership rather than by an account role:
 * `CONTEXTS.md` §4, and the reason the context exists.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import {
  type Invitation,
  type Membership,
  type OrgId,
  type Organization,
  OrgRole,
} from '../../domain/index.js';
import { membershipOf, require } from '../authorize.js';
import { type OrgsDeps } from '../ports.js';

/** The organizations this caller belongs to. Never a global list. */
export function myOrgs(
  deps: OrgsDeps,
  subject: Subject,
): Promise<readonly Organization[]> {
  return deps.orgs.forUser(subjectId(subject));
}

export async function readOrg(
  deps: OrgsDeps,
  subject: Subject,
  org: OrgId,
): Promise<{ org: Organization; role: OrgRole }> {
  const membership = await membershipOf(deps.memberships, org, subject);
  const found = await deps.orgs.byId(org);
  if (found === undefined) throw new Error('unreachable: member of nothing');
  // **The caller\'s own role travels with the view.** A client rendering an
  // organization needs to know what it may offer, and asking a second endpoint
  // for that is a second round trip and a second chance to disagree.
  return { org: found, role: membership.role };
}

export async function readRoster(
  deps: OrgsDeps,
  subject: Subject,
  org: OrgId,
): Promise<readonly Membership[]> {
  // Any member sees the roster: an organization whose members cannot see each
  // other is not a shared thing, it is several private ones.
  await membershipOf(deps.memberships, org, subject);
  return deps.memberships.list(org);
}

export async function readPending(
  deps: OrgsDeps,
  subject: Subject,
  org: OrgId,
): Promise<readonly Invitation[]> {
  // Admin and above: an outstanding invitation names an address that has not
  // agreed to be visible to the whole roster yet.
  await require(deps.memberships, org, subject, OrgRole.Admin);
  return deps.invitations.pending(org);
}
