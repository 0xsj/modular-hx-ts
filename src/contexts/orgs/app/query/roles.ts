/**
 * A user\'s memberships, for the port `identity` declares. **`orgs` app.**
 *
 * > Identity learns a caller\'s org roles through a port the root wires, so
 * > neither context imports the other, and `ORGS_ENABLED=false` is a working
 * > configuration. — `CONTEXTS.md` §4
 *
 * **This is the satisfying half.** The declaring half is
 * `identity/app/ports.ts`, which names the shape it needs without knowing that
 * anything provides it; `src/wire.ts` is the only file that sees both. Neither
 * context imports the other, so `S6` holds — and it holds because the seam is
 * real rather than because a rule was worked around.
 *
 * **No `Subject`, and no authorization.** This is not a use case a caller
 * invokes; it is the data `identity` needs in order to *build* a subject, and
 * it runs before there is one to check. An authorization check here would be
 * circular by construction.
 */

import { type OrgsDeps } from '../ports.js';

export interface OrgMembership {
  readonly orgId: string;
  readonly role: string;
}

export async function orgMemberships(
  deps: OrgsDeps,
  userId: string,
): Promise<readonly OrgMembership[]> {
  const held = await deps.memberships.forUser(userId);
  return held.map((membership) => ({
    orgId: membership.orgId,
    role: membership.role,
  }));
}
