/**
 * The `Membership` aggregate. **`orgs` domain.**
 *
 * A user in an organization, with a role **in that organization**. The pair
 * `(orgId, userId)` is unique, and the uniqueness is the repository's — a
 * read-then-insert has a window, and the window is exactly the case where two
 * invitations for the same address are accepted at once.
 *
 * **The user id is an opaque string here, and deliberately not an `identity`
 * type.** `S6` forbids importing one, and that is the right answer rather than
 * a limitation worked around: this context knows that a membership names
 * *somebody*, and knows nothing about what makes somebody exist.
 *
 * See `notes/domain/orgs.md`.
 */

import { type MembershipId, type OrgId } from './ids.js';
import { type OrgRole } from './role.js';

export interface MembershipState {
  readonly id: MembershipId;
  readonly orgId: OrgId;
  /** The `identity` user id, as an opaque string. See above. */
  readonly userId: string;
  readonly role: OrgRole;
  readonly joinedAt: Date;
  readonly version: number;
}

export interface Changed {
  readonly changed: boolean;
}

export class Membership {
  #role: OrgRole;
  #version: number;

  readonly id: MembershipId;
  readonly orgId: OrgId;
  readonly userId: string;
  readonly joinedAt: Date;
  readonly baseVersion: number;

  private constructor(state: MembershipState) {
    this.id = state.id;
    this.orgId = state.orgId;
    this.userId = state.userId;
    this.joinedAt = state.joinedAt;
    this.baseVersion = state.version;

    this.#role = state.role;
    this.#version = state.version;
  }

  static join(
    id: MembershipId,
    org: OrgId,
    userId: string,
    role: OrgRole,
    at: Date,
  ): Membership {
    return new Membership({
      id,
      orgId: org,
      userId,
      role,
      joinedAt: at,
      version: 1,
    });
  }

  static from(state: MembershipState): Membership {
    return new Membership(state);
  }

  get role(): OrgRole {
    return this.#role;
  }
  get version(): number {
    return this.#version;
  }

  /**
   * Change the role. **Idempotent, and it does not check the roster.**
   *
   * The last-owner rule lives in `roster.ts` and is checked *before* this is
   * called, because it is a property of the set and this object is one member
   * of it. An aggregate that tried to enforce it would need to hold every other
   * membership to do so, which is the definition of the wrong boundary.
   */
  changeRole(role: OrgRole): Changed {
    if (this.#role === role) return { changed: false };
    this.#role = role;
    this.#version += 1;
    return { changed: true };
  }

  toState(): MembershipState {
    return {
      id: this.id,
      orgId: this.orgId,
      userId: this.userId,
      role: this.#role,
      joinedAt: this.joinedAt,
      version: this.#version,
    };
  }
}
