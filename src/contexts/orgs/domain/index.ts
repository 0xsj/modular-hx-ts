/**
 * The domain\'s root, and the one place `S7`\'s consequence is stated.
 *
 * `result` is not importable here, so value objects **throw** rather than
 * returning one. `ARCHITECTURE.md` §L0 calls `errors` *and* `result` the
 * kernel\'s vocabulary while `ENFORCEMENT.md` `S7` permits only `errors` — a gap
 * that matters in a language with a `Result` type and not in Go. Followed as
 * written, raised rather than widened; the same choice `identity` made, and
 * making it twice is what turns it from a judgement into a convention.
 */

export {
  type InvitationId,
  type MembershipId,
  type OrgId,
  invitationId,
  membershipId,
  orgId,
} from './ids.js';
export { OrgRole, atLeast, orgRole } from './role.js';
export {
  type Changed,
  type OrgState,
  Organization,
  slug,
  slugify,
} from './organization.js';
export { type MembershipState, Membership } from './membership.js';
export { type RosterEntry, assertOwnerRemains, ownerCount } from './roster.js';
export {
  type InvitationState,
  Invitation,
  invitationRefused,
} from './invitation.js';
export { OrgEvent } from './events.js';
