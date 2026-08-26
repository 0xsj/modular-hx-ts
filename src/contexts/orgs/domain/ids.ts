/**
 * Typed ids. **`orgs` domain.**
 *
 * Branded **locally**, because `S7` permits this directory exactly one import
 * and `brand` is not it. Four lines against an architectural boundary worth
 * keeping: a domain that may import one helper may import two.
 */

declare const Brand: unique symbol;

type Branded<T, K extends string> = T & { readonly [Brand]: K };

export type OrgId = Branded<string, 'OrgId'>;
export type MembershipId = Branded<string, 'MembershipId'>;
export type InvitationId = Branded<string, 'InvitationId'>;

export const orgId = (raw: string): OrgId => raw as OrgId;
export const membershipId = (raw: string): MembershipId => raw as MembershipId;
export const invitationId = (raw: string): InvitationId => raw as InvitationId;
