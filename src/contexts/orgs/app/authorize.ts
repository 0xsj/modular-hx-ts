/**
 * Authorization **inside one organization**. **`orgs` app.**
 *
 * `CONTEXTS.md` §4, and this is the whole reason the context is in the constant
 * set: a caller\'s permission is read from their role **in the organization the
 * resource belongs to**, never from a flat account role.
 *
 * **Why this is here and not in `authz`.** `authz` decides from a `Subject`\'s
 * roles and a scope, and a `Subject` carries one set of roles for the whole
 * request. That model is correct for account-wide permissions and cannot
 * express *owner here, member there* — the same person, the same request, two
 * answers depending on which organization the resource is in. Encoding org
 * roles into the `Subject` would mean minting one subject per organization, and
 * the number of organizations is not known when the subject is built.
 *
 * So the decision reads the roster. It is a lookup rather than a table, and it
 * is the shape every context built after this one inherits.
 *
 * **An account administrator is not an organization owner.** `identity`\'s
 * `admin` says what somebody may do to the *system*; it deliberately does not
 * confer a role inside somebody else\'s organization. Nothing in this file looks
 * at account roles, and that omission is the point rather than a gap.
 */

import { type Subject, subjectId } from '../../../shared/authz/index.js';
import { forbidden, notFound } from '../../../shared/errors/index.js';
import {
  type Membership,
  type OrgId,
  type OrgRole,
  atLeast,
} from '../domain/index.js';
import { type Memberships } from './ports.js';

/**
 * The caller\'s membership, or a refusal that **does not confirm the org
 * exists**.
 *
 * A non-member gets 404, not 403 — conformance case 23\'s rule applied to
 * organizations: a 403 confirms the resource is there and turns any id into an
 * oracle for *which organizations exist*, which is a membership list nobody
 * asked to publish.
 */
export async function membershipOf(
  memberships: Memberships,
  org: OrgId,
  subject: Subject,
): Promise<Membership> {
  const found = await memberships.of(org, subjectId(subject));
  if (found === undefined) throw notFound('no such organization');
  return found;
}

/**
 * Require at least `needed` **in this organization**.
 *
 * The refusal is `Forbidden` rather than `NotFound`, and the difference from
 * above is deliberate: the caller has already proved they are a member, so the
 * organization\'s existence is not a secret from them any more. Only *what they
 * may do inside it* is at issue.
 */
export async function require(
  memberships: Memberships,
  org: OrgId,
  subject: Subject,
  needed: OrgRole,
): Promise<Membership> {
  const membership = await membershipOf(memberships, org, subject);
  if (!atLeast(membership.role, needed)) {
    throw forbidden(
      `this action needs the ${needed} role in this organization`,
    );
  }
  return membership;
}
