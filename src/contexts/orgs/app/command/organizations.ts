/**
 * Found, rename and archive an organization. **`orgs` app · command.**
 *
 * See `notes/domain/orgs.md`.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type OrgId,
  type Organization,
  Membership,
  OrgEvent,
  OrgRole,
  Organization as OrgAggregate,
  membershipId,
  orgId as toOrgId,
  slug as toSlug,
} from '../../domain/index.js';
import { require } from '../authorize.js';
import { type OrgsDeps } from '../ports.js';

export interface FoundInput {
  readonly name: string;
  readonly slug?: string | undefined;
}

/**
 * Found an organization. **The founder is its first owner, in one transaction.**
 *
 * Two writes that must not come apart: an organization with no memberships is
 * one nobody can administer and nobody can archive, and it would satisfy the
 * last-owner invariant vacuously — zero owners is not *at least one*, but a
 * roster of zero has nobody to refuse. Creating both together is what stops
 * that state from existing rather than being cleaned up.
 */
export async function foundOrg(
  deps: OrgsDeps,
  subject: Subject,
  input: FoundInput,
  provenance: Provenance,
): Promise<Organization> {
  const at = deps.clock.now();
  const org = OrgAggregate.found(
    toOrgId(deps.ids.uuid()),
    input.name,
    at,
    input.slug === undefined ? undefined : toSlug(input.slug),
  );

  const founder = Membership.join(
    membershipId(deps.ids.uuid()),
    org.id,
    subjectId(subject),
    OrgRole.Owner,
    at,
  );

  return deps.transactor.within(async (work) => {
    // Uniqueness on the slug is the repository\'s: a duplicate arrives as
    // `Conflict` from a unique violation rather than from a read this command
    // performed, because a read-then-insert has a window and the window is
    // exactly the concurrent-signup case.
    await work.orgs.create(org);
    await work.memberships.create(founder);

    await work.publish(
      {
        name: OrgEvent.OrgFounded,
        payload: { subject: org.id, name: org.name, slug: org.slug },
      },
      provenance,
    );
    await work.publish(
      {
        name: OrgEvent.MemberJoined,
        payload: {
          subject: founder.userId,
          orgId: org.id,
          role: founder.role,
          via: 'founded',
        },
      },
      provenance,
    );

    return org;
  });
}

export interface RenameInput {
  readonly org: OrgId;
  readonly name: string;
}

export async function renameOrg(
  deps: OrgsDeps,
  subject: Subject,
  input: RenameInput,
  provenance: Provenance,
): Promise<Organization> {
  await require(deps.memberships, input.org, subject, OrgRole.Admin);

  return deps.transactor.within(async (work) => {
    const org = await loaded(work.orgs, input.org);
    if (!org.rename(input.name, deps.clock.now()).changed) return org;

    await work.orgs.save(org);
    await work.publish(
      {
        name: OrgEvent.OrgRenamed,
        payload: { subject: org.id, name: org.name },
      },
      provenance,
    );
    return org;
  });
}

/**
 * Archive it. **Owner only, and archived is not deleted.**
 *
 * The memberships stay, the audit trail stays, and the slug stays — releasing
 * it would let somebody else take the name of an organization whose records
 * still exist, which is how a link in an old email starts pointing somewhere
 * new.
 */
export async function archiveOrg(
  deps: OrgsDeps,
  subject: Subject,
  org: OrgId,
  provenance: Provenance,
): Promise<Organization> {
  await require(deps.memberships, org, subject, OrgRole.Owner);

  return deps.transactor.within(async (work) => {
    const found = await loaded(work.orgs, org);
    if (!found.archive(deps.clock.now()).changed) return found;

    await work.orgs.save(found);
    await work.publish(
      { name: OrgEvent.OrgArchived, payload: { subject: found.id } },
      provenance,
    );
    return found;
  });
}

async function loaded(
  orgs: { byId(id: OrgId): Promise<Organization | undefined> },
  id: OrgId,
): Promise<Organization> {
  const found = await orgs.byId(id);
  // Unreachable: `require` above already proved membership, which proves the
  // organization exists. A guard rather than a `!`, because the day it *is*
  // reachable is the day somebody reorders these two lines.
  if (found === undefined) {
    throw new Error(`unreachable: organization ${id} vanished mid-transaction`);
  }
  return found;
}
