/**
 * The `Invitation` aggregate. **`orgs` domain.**
 *
 * > Invitations are single-use MAC-tagged tokens, keyring-aware so rotation
 * > does not break outstanding links — **the `Challenge` shape again**, over a
 * > different subject. — `CONTEXTS.md` §4
 *
 * It is the same shape and it is **not the same code**, and the reason is worth
 * stating precisely because it looks like a failure to reuse.
 *
 * `S7` permits this directory exactly one import: `errors`. No shared module is
 * reachable from where an aggregate lives, so `identity`'s `Challenge` class
 * cannot be imported here and neither could a promoted one. That is the rule
 * working: an aggregate is a context's own model, and two contexts sharing one
 * would be two contexts with one model — a change to this context's expiry
 * rules would be a change to `identity`'s.
 *
 * What **is** shared is the mechanics, which have no domain in them:
 * `shared/token` mints the secret, fingerprints it and builds the MAC message,
 * and this context's `app/` layer calls it. The shape is reused; the model is
 * not. See `notes/patterns/token.md`.
 *
 * The four properties are the same four, over a different subject:
 *
 * - **Single-use.** `consumedAt` is set once; a second consume fails.
 * - **TTL\'d.** An emailed invitation that never expires is a standing offer of
 *   membership in a mailbox.
 * - **Bound to its org, email and role inside the MAC.** An invitation to be a
 *   *member* of one organization cannot be replayed as an *owner* of another.
 * - **Keyring-aware**, so rotating the signing key does not invalidate links
 *   already in flight — the tag carries its key id, and `crypto` verifies
 *   against the ring.
 *
 * See `notes/domain/orgs.md`.
 */

import { invalid } from '../../../shared/errors/index.js';
import { type InvitationId, type OrgId } from './ids.js';
import { type OrgRole } from './role.js';

export interface InvitationState {
  readonly id: InvitationId;
  readonly orgId: OrgId;
  /** Lowercased at construction by the caller\'s value object. */
  readonly email: string;
  /** The role the invitation confers. **Exactly one**, decided at issue. */
  readonly role: OrgRole;
  /** `sha256:` of the emailed secret. Never the secret. */
  readonly secretFingerprint: string;
  /** `v1.<kid>.<tag>` binding id, org, email and role together. */
  readonly tag: string;
  /** Who sent it, as an opaque `identity` user id. */
  readonly invitedBy: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date | undefined;
  readonly revokedAt?: Date | undefined;
  readonly version: number;
}

export class Invitation {
  #consumedAt: Date | undefined;
  #revokedAt: Date | undefined;
  #version: number;

  readonly id: InvitationId;
  readonly orgId: OrgId;
  readonly email: string;
  readonly role: OrgRole;
  readonly secretFingerprint: string;
  readonly tag: string;
  readonly invitedBy: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly baseVersion: number;

  private constructor(state: InvitationState) {
    this.id = state.id;
    this.orgId = state.orgId;
    this.email = state.email;
    this.role = state.role;
    this.secretFingerprint = state.secretFingerprint;
    this.tag = state.tag;
    this.invitedBy = state.invitedBy;
    this.issuedAt = state.issuedAt;
    this.expiresAt = state.expiresAt;
    this.baseVersion = state.version;

    this.#consumedAt = state.consumedAt;
    this.#revokedAt = state.revokedAt;
    this.#version = state.version;
  }

  static issue(
    id: InvitationId,
    org: OrgId,
    email: string,
    role: OrgRole,
    secretFingerprint: string,
    tag: string,
    invitedBy: string,
    at: Date,
    expiresAt: Date,
  ): Invitation {
    return new Invitation({
      id,
      orgId: org,
      email,
      role,
      secretFingerprint,
      tag,
      invitedBy,
      issuedAt: at,
      expiresAt,
      version: 1,
    });
  }

  static from(state: InvitationState): Invitation {
    return new Invitation(state);
  }

  get consumedAt(): Date | undefined {
    return this.#consumedAt;
  }
  get revokedAt(): Date | undefined {
    return this.#revokedAt;
  }
  get version(): number {
    return this.#version;
  }

  isUsableAt(now: Date): boolean {
    if (this.#consumedAt !== undefined) return false;
    if (this.#revokedAt !== undefined) return false;
    return now.getTime() < this.expiresAt.getTime();
  }

  /**
   * Spend it, once.
   *
   * **Says nothing about why it failed.** Expired, already accepted, revoked
   * and never existed are one indistinguishable error — the same rule
   * conformance case 13 fixes for `identity`\'s links, and it applies here for
   * the same reason: four distinct errors let somebody holding a stale
   * invitation learn whether the organization exists, whether the address is
   * already a member, and whether they guessed a real id.
   */
  consume(at: Date): void {
    if (!this.isUsableAt(at)) throw invitationRefused();
    this.#consumedAt = at;
    this.#version += 1;
  }

  /** Withdraw an outstanding invitation. Idempotent. */
  revoke(at: Date): { readonly changed: boolean } {
    if (this.#revokedAt !== undefined || this.#consumedAt !== undefined) {
      return { changed: false };
    }
    this.#revokedAt = at;
    this.#version += 1;
    return { changed: true };
  }

  toState(): InvitationState {
    return {
      id: this.id,
      orgId: this.orgId,
      email: this.email,
      role: this.role,
      secretFingerprint: this.secretFingerprint,
      tag: this.tag,
      invitedBy: this.invitedBy,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      ...(this.#consumedAt === undefined
        ? {}
        : { consumedAt: this.#consumedAt }),
      ...(this.#revokedAt === undefined ? {} : { revokedAt: this.#revokedAt }),
      version: this.#version,
    };
  }
}

/**
 * **The one refusal, for every reason.**
 *
 * Built here so no call site can spell it differently, and so adding a failure
 * mode later has nothing to spell at all. `Invalid` rather than `NotFound`: a
 * 404 for *never existed* and a 400 for *already used* is the same oracle
 * wearing two status codes.
 */
export function invitationRefused(): Error {
  return invalid('this invitation is not valid');
}
