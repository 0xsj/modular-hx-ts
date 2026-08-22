// `identity` publishing under the `orgs` prefix. Routes to the wrong
// subscribers and lands in the wrong half of the audit graph.
export const MEMBERSHIP_REVOKED = 'orgs.membership.revoked';
export const USER_REGISTERED = 'identity.user.registered'; // correct, ignored
