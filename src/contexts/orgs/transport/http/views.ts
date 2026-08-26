/**
 * What `orgs` puts on the wire. **`orgs` transport.**
 *
 * Views, not aggregates. Snake case, because `../../../../../CONFORMANCE.md`
 * §3.5 makes the wire vocabulary normative: a client must not be able to tell
 * which blueprint it reached.
 */

import {
  type Invitation,
  type Membership,
  type OrgRole,
  type Organization,
} from '../../domain/index.js';

export interface OrgView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'archived';
  /** The **caller\'s** role in this organization, when the view has one. */
  readonly your_role?: OrgRole;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export function orgView(org: Organization, yourRole?: OrgRole): OrgView {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    status: org.archived ? 'archived' : 'active',
    ...(yourRole === undefined ? {} : { your_role: yourRole }),
    version: org.version,
    created_at: org.createdAt.toISOString(),
    updated_at: org.updatedAt.toISOString(),
  };
}

export interface MemberView {
  readonly id: string;
  readonly user_id: string;
  readonly role: OrgRole;
  readonly joined_at: string;
}

export function memberView(membership: Membership): MemberView {
  return {
    id: membership.id,
    user_id: membership.userId,
    role: membership.role,
    joined_at: membership.joinedAt.toISOString(),
  };
}

export interface InvitationView {
  readonly id: string;
  readonly email: string;
  readonly role: OrgRole;
  readonly invited_by: string;
  readonly expires_at: string;
}

/** **No secret and no fingerprint.** Nothing here can leak one. */
export function invitationView(invitation: Invitation): InvitationView {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invited_by: invitation.invitedBy,
    expires_at: invitation.expiresAt.toISOString(),
  };
}
