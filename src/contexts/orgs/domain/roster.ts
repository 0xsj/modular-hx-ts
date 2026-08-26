/**
 * The roster, and **the first invariant in this collection that spans a set**.
 *
 * > An org always keeps at least one owner, enforced in the domain over the
 * > whole roster, not per handler. — `CONTEXTS.md` §4
 *
 * `CONTEXTS.md` §7.1 observes that every invariant in v1 was **intra-aggregate**
 * — a rule one object could check by looking at itself. This one is not: *at
 * least one owner* is a property of the membership **set**, and no single
 * `Membership` can see enough to enforce it.
 *
 * **Three places it could have gone, and why this is the one.**
 *
 * - **On `Membership`.** It would have to hold every sibling to answer, which
 *   is the wrong boundary wearing the right name — an aggregate that needs the
 *   whole collection is the whole collection.
 * - **On `Organization`, holding the roster.** This is the textbook answer and
 *   it is wrong at any real size: every role change would load and write the
 *   entire membership list to protect one row, and the version on the
 *   organization would move every time anybody joined.
 * - **Here: a pure function over a roster snapshot**, called by the command
 *   *inside the transaction that already read it*. No I/O, no aggregate, no
 *   second read — and `S7` holds, because this imports only `errors`.
 *
 * **The snapshot is what makes it correct rather than probable.** The command
 * reads the roster in the same transaction as the write, at the isolation level
 * the repository sets, so the set it checks is the set it changes. Checking
 * outside the transaction would be a time-of-check-to-time-of-use race with a
 * very specific loss: two concurrent requests each demoting a different owner,
 * each seeing two, and an organization left with none.
 *
 * See `notes/domain/orgs.md`.
 */

import { conflict } from '../../../shared/errors/index.js';
import { OrgRole } from './role.js';

/** What the check needs to know about one member. Not the aggregate. */
export interface RosterEntry {
  readonly userId: string;
  readonly role: OrgRole;
}

/** The one refusal, so no call site can spell it differently. */
function lastOwner(what: string): Error {
  // `Conflict`, not `Forbidden`: the caller is permitted to do this in general
  // and the **state** is what refuses. A 403 would tell an owner they lack a
  // permission they have.
  return conflict(`an organization keeps at least one owner: ${what}`, {
    problem: 'last-owner',
  });
}

const owners = (roster: readonly RosterEntry[]): readonly RosterEntry[] =>
  roster.filter((entry) => entry.role === OrgRole.Owner);

/**
 * Refuse a change that would leave the organization with no owner.
 *
 * **One function for demote, remove and leave**, because they are the same
 * question asked three ways — and three separate checks is how the third one
 * ends up missing the case the first two cover. §4 names all three: the last
 * owner cannot leave, cannot be demoted, and cannot be removed.
 *
 * `next` is `undefined` when the member is going away entirely.
 */
export function assertOwnerRemains(
  roster: readonly RosterEntry[],
  userId: string,
  next: OrgRole | undefined,
  what: string,
): void {
  const current = roster.find((entry) => entry.userId === userId);
  // Not a member, or not an owner: this change cannot remove an owner, so the
  // roster is not the thing that decides it.
  if (current?.role !== OrgRole.Owner) return;
  if (next === OrgRole.Owner) return;

  if (owners(roster).length <= 1) throw lastOwner(what);
}

/** How many owners the roster holds. For a view, never for a decision. */
export function ownerCount(roster: readonly RosterEntry[]): number {
  return owners(roster).length;
}
