/**
 * The roster. **`orgs` app · command.**
 *
 * Every command here reads the roster **inside the transaction it is about to
 * change**, and checks `assertOwnerRemains` before writing. That is the
 * collection\'s first set-spanning invariant, and the transaction is what makes
 * it correct rather than probable — see `domain/roster.ts`.
 *
 * See `notes/domain/orgs.md`.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { conflict, notFound } from '../../../../shared/errors/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Membership,
  type OrgId,
  type OrgRole,
  OrgEvent,
  OrgRole as Role,
  assertOwnerRemains,
} from '../../domain/index.js';
import { require } from '../authorize.js';
import { type OrgsDeps, type Work } from '../ports.js';

export interface ChangeRoleInput {
  readonly org: OrgId;
  readonly userId: string;
  readonly role: OrgRole;
}

/**
 * Change somebody\'s role in this organization.
 *
 * **Admin or above to call, and the roster decides whether it may happen.**
 * Those are two different questions and both refuse: an admin may change roles
 * in general, and may still not demote the last owner.
 */
export async function changeRole(
  deps: OrgsDeps,
  subject: Subject,
  input: ChangeRoleInput,
  provenance: Provenance,
): Promise<Membership> {
  const actor = await require(deps.memberships, input.org, subject, Role.Admin);

  // **Only an owner makes an owner.** An admin who could promote themselves is
  // an admin who is already an owner, and the ladder would have no rungs.
  if (input.role === Role.Owner && actor.role !== Role.Owner) {
    throw conflict('only an owner can make somebody else an owner');
  }

  return deps.transactor.within(async (work) => {
    const membership = await member(work, input.org, input.userId);
    const roster = await work.memberships.roster(input.org);

    assertOwnerRemains(
      roster,
      input.userId,
      input.role,
      'demoting the last owner',
    );

    if (!membership.changeRole(input.role).changed) return membership;

    await work.memberships.save(membership);
    await work.publish(
      {
        name: OrgEvent.MemberRoleChanged,
        payload: {
          subject: membership.userId,
          orgId: input.org,
          role: membership.role,
        },
      },
      provenance,
    );
    return membership;
  });
}

/**
 * Remove somebody. **Admin or above, and never the last owner.**
 *
 * `MemberRemoved` rather than `MemberLeft`: the two differ only in who did it,
 * and that is exactly the difference an audit trail exists to record. A single
 * event with a `by` field would work and would make *who removed whom* a field
 * somebody has to remember to read.
 */
export async function removeMember(
  deps: OrgsDeps,
  subject: Subject,
  input: { readonly org: OrgId; readonly userId: string },
  provenance: Provenance,
): Promise<void> {
  await require(deps.memberships, input.org, subject, Role.Admin);

  await deps.transactor.within(async (work) => {
    const membership = await member(work, input.org, input.userId);
    const roster = await work.memberships.roster(input.org);

    assertOwnerRemains(
      roster,
      input.userId,
      undefined,
      'removing the last owner',
    );

    await work.memberships.remove(membership.id);
    await work.publish(
      {
        name: OrgEvent.MemberRemoved,
        payload: { subject: membership.userId, orgId: input.org },
      },
      provenance,
    );
  });
}

/**
 * Leave. **Any member, and still never the last owner.**
 *
 * The same roster check as `removeMember`, and deliberately not a special case
 * of it: they differ in who may call them and in the event they publish, and
 * folding them together would put an `if` in the middle of an authorization
 * decision.
 */
export async function leaveOrg(
  deps: OrgsDeps,
  subject: Subject,
  org: OrgId,
  provenance: Provenance,
): Promise<void> {
  const me = subjectId(subject);
  await require(deps.memberships, org, subject, Role.Member);

  await deps.transactor.within(async (work) => {
    const membership = await member(work, org, me);
    const roster = await work.memberships.roster(org);

    assertOwnerRemains(roster, me, undefined, 'the last owner cannot leave');

    await work.memberships.remove(membership.id);
    await work.publish(
      {
        name: OrgEvent.MemberLeft,
        payload: { subject: me, orgId: org },
      },
      provenance,
    );
  });
}

async function member(
  work: Work,
  org: OrgId,
  userId: string,
): Promise<Membership> {
  const found = await work.memberships.of(org, userId);
  if (found === undefined)
    throw notFound('no such member of this organization');
  return found;
}
