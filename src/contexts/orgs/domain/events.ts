/**
 * What `orgs` publishes. **`orgs` domain.**
 *
 * `<context>.<aggregate>.<past-tense-verb>`, subject in the payload, actor on
 * the envelope — §2.5, and rule `M6` checks the prefix matches the directory.
 *
 * **A cross-context contract rather than this context\'s choice.** `audit`
 * imports no context and cannot look anything up, so every name and every
 * payload field here is read by something that will never see this file.
 */

export const OrgEvent = {
  OrgFounded: 'orgs.organization.founded',
  OrgRenamed: 'orgs.organization.renamed',
  OrgArchived: 'orgs.organization.archived',
  MemberJoined: 'orgs.membership.joined',
  MemberRoleChanged: 'orgs.membership.role_changed',
  MemberLeft: 'orgs.membership.left',
  MemberRemoved: 'orgs.membership.removed',
  InvitationSent: 'orgs.invitation.sent',
  InvitationAccepted: 'orgs.invitation.accepted',
  InvitationRevoked: 'orgs.invitation.revoked',
} as const;

export type OrgEvent = (typeof OrgEvent)[keyof typeof OrgEvent];
