/**
 * Invite, accept, revoke. **`orgs` app · command.**
 *
 * **The `Challenge` shape, over an organization.** The mechanics come from
 * `shared/token` — mint, fingerprint, bind — and the aggregate is this
 * context\'s own, because `S7` puts no shared module within reach of a
 * `domain/`. See `notes/patterns/token.md` for why that is the rule working.
 *
 * See `notes/domain/orgs.md`.
 */

import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import { conflict, notFound } from '../../../../shared/errors/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  issue as issueLink,
  matches,
  readable,
} from '../../../../shared/secretlink/index.js';
import { bind } from '../../../../shared/token/index.js';
import {
  type Invitation,
  type Membership,
  type OrgId,
  type OrgRole,
  Invitation as InvitationAggregate,
  Membership as MembershipAggregate,
  OrgEvent,
  OrgRole as Role,
  invitationId,
  invitationRefused,
  membershipId,
} from '../../domain/index.js';
import { require } from '../authorize.js';
import { type OrgsDeps } from '../ports.js';

/**
 * **The second tag, and it is not the one on the wire.**
 *
 * `secretlink` puts a tag on the token that binds the **id alone**, so a forged
 * identifier is refused before any lookup. This one binds the *contents* — org,
 * email and role — and is stored beside the row, so a write that edits the role
 * column is caught after the lookup.
 *
 * Two tags for two threats, and neither does the other's job. The wire tag
 * cannot bind a role, because the role is not known until the row is read; the
 * stored tag cannot be checked first, for the same reason.
 *
 * **The role is in it.** Without that, an invitation to be a *member* is
 * byte-identical in effect to one for *owner*, and a row somebody edits becomes
 * a promotion nobody authorized.
 */
function invitationMessage(
  id: string,
  org: OrgId,
  email: string,
  role: OrgRole,
): string {
  return bind(id, org, email, role);
}

export interface InviteInput {
  readonly org: OrgId;
  readonly email: string;
  readonly role: OrgRole;
}

export async function invite(
  deps: OrgsDeps,
  subject: Subject,
  input: InviteInput,
  provenance: Provenance,
): Promise<void> {
  const actor = await require(deps.memberships, input.org, subject, Role.Admin);
  if (input.role === Role.Owner && actor.role !== Role.Owner) {
    throw conflict('only an owner can invite somebody as an owner');
  }

  const email = input.email.trim().toLowerCase();
  const at = deps.clock.now();
  const id = invitationId(deps.ids.uuid());
  const link = unwrap(issueLink({ id, random: deps.random, mac: deps.mac }));

  const invitation = InvitationAggregate.issue(
    id,
    input.org,
    email,
    input.role,
    link.fingerprint,
    unwrap(deps.mac.tag(invitationMessage(id, input.org, email, input.role))),
    subjectId(subject),
    at,
    new Date(at.getTime() + deps.invitationTtlMs),
  );

  const org = await deps.orgs.byId(input.org);
  if (org === undefined) throw notFound('no such organization');

  await deps.transactor.within(async (work) => {
    await work.invitations.create(invitation);
    await work.publish(
      {
        name: OrgEvent.InvitationSent,
        payload: {
          subject: invitation.id,
          orgId: input.org,
          // **The address, never the secret.** An event is durable and reaches
          // `audit`; a secret on one is a secret in a table nobody rotates.
          email,
          role: input.role,
        },
      },
      provenance,
    );
  });

  // **Sent after the transaction commits**, because a mail that goes out for a
  // row that rolled back is an invitation to an organization the recipient can
  // never join — and the reverse, a committed row whose mail failed, is a
  // revocable, retryable, visible problem.
  await deps.mailer.send(email, { id: org.id, name: org.name }, link.token);
}

/**
 * Accept an invitation. **The token proves the address; the caller supplies
 * the identity.**
 *
 * The invited email is *not* compared against the caller\'s address, and that is
 * deliberate rather than an omission: `orgs` cannot see an `identity` user\'s
 * email — `S6` — and asking for it would make this context depend on the other.
 * Possession of the emailed secret is the proof, which is the same proof
 * `identity`\'s links rely on.
 */
export async function acceptInvitation(
  deps: OrgsDeps,
  subject: Subject,
  token: string,
  provenance: Provenance,
): Promise<Membership> {
  const userId = subjectId(subject);

  // **Authenticated before the lookup**, which is the reason the wire tag
  // exists: without it, an id on the wire is an id an attacker can forge and
  // probe against the table, one request per guess.
  const link = readable(token, deps.mac);
  // **This context's refusal, not the module's.** `secretlink` used to export
  // one, and using it here made a malformed token say something different from
  // an expired one — which is precisely the oracle case 13 forbids, introduced
  // by the extraction and caught by the test that asserts the two are equal.
  // The message belongs to the surface, so the module no longer offers one.
  if (link === undefined) throw invitationRefused();

  return deps.transactor.within(async (work) => {
    const invitation = await work.invitations.byId(invitationId(link.id));
    if (invitation === undefined) throw invitationRefused();

    // Possession, in constant time.
    if (!matches(link, invitation.secretFingerprint)) throw invitationRefused();

    // **And the stored tag proves the row was not edited.** The wire tag bound
    // the id; this binds the contents, so a write that flipped the role column
    // cannot turn a membership into an ownership.
    const expected = invitationMessage(
      invitation.id,
      invitation.orgId,
      invitation.email,
      invitation.role,
    );
    if (!deps.mac.verify(expected, invitation.tag)) throw invitationRefused();

    // Throws the same refusal for expired, revoked and already accepted.
    invitation.consume(deps.clock.now());
    await work.invitations.save(invitation);

    const already = await work.memberships.of(invitation.orgId, userId);
    if (already !== undefined) {
      // **Already a member: the invitation is spent and nothing else happens.**
      // Not an error — a second person forwarding the link to somebody who
      // joined last week is not a failure, and refusing here would leave a
      // live invitation somebody could still use.
      await work.publish(
        {
          name: OrgEvent.InvitationAccepted,
          payload: {
            subject: userId,
            orgId: invitation.orgId,
            invitationId: invitation.id,
            joined: false,
          },
        },
        provenance,
      );
      return already;
    }

    const membership = MembershipAggregate.join(
      membershipId(deps.ids.uuid()),
      invitation.orgId,
      userId,
      invitation.role,
      deps.clock.now(),
    );
    await work.memberships.create(membership);

    await work.publish(
      {
        name: OrgEvent.InvitationAccepted,
        payload: {
          subject: userId,
          orgId: invitation.orgId,
          invitationId: invitation.id,
          joined: true,
        },
      },
      provenance,
    );
    await work.publish(
      {
        name: OrgEvent.MemberJoined,
        payload: {
          subject: userId,
          orgId: invitation.orgId,
          role: membership.role,
          via: 'invitation',
        },
      },
      provenance,
    );

    return membership;
  });
}

export async function revokeInvitation(
  deps: OrgsDeps,
  subject: Subject,
  input: { readonly org: OrgId; readonly invitation: string },
  provenance: Provenance,
): Promise<void> {
  await require(deps.memberships, input.org, subject, Role.Admin);

  await deps.transactor.within(async (work) => {
    const found = await work.invitations.byId(invitationId(input.invitation));
    // **Scoped to the org in the path**, not just looked up by id: an admin of
    // one organization must not be able to revoke another\'s invitation by
    // guessing an id, and the id is the only thing they would need.
    if (found?.orgId !== input.org) {
      throw notFound('no such invitation');
    }
    if (!found.revoke(deps.clock.now()).changed) return;

    await work.invitations.save(found);
    await work.publish(
      {
        name: OrgEvent.InvitationRevoked,
        payload: { subject: found.id, orgId: input.org },
      },
      provenance,
    );
  });
}

export type { Invitation };
