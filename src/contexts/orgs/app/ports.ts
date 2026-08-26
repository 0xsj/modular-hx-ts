/**
 * The out-ports `orgs` needs. **Declared by `app/`, injected by the root** —
 * `S8`.
 *
 * `Work` is why `app/` never sees a `DB`: `ARCHITECTURE.md` §4 requires the
 * outbox row in the *same* transaction as the data write, so publishing needs
 * the transaction handle — this hands out repositories already bound to it.
 *
 * See `notes/domain/orgs.md`.
 */

import { type Mac } from '../../../shared/crypto/index.js';
import { type Random } from '../../../shared/random/index.js';
import { type Event, type Publisher } from '../../../shared/events/index.js';
import { type Provenance } from '../../../shared/provenance/index.js';
import {
  type InvitationId,
  type MembershipId,
  type OrgId,
  type Invitation,
  type Membership,
  type Organization,
  type RosterEntry,
} from '../domain/index.js';

export interface Organizations {
  byId(id: OrgId): Promise<Organization | undefined>;
  bySlug(slug: string): Promise<Organization | undefined>;
  /** Organizations a user belongs to. The list `GET /v1/orgs` renders. */
  forUser(userId: string): Promise<readonly Organization[]>;
  create(org: Organization): Promise<void>;
  /** Writes on `(id, baseVersion)`. A mismatch raises `Conflict`. */
  save(org: Organization): Promise<void>;
}

export interface Memberships {
  byId(id: MembershipId): Promise<Membership | undefined>;
  of(org: OrgId, userId: string): Promise<Membership | undefined>;
  /**
   * **The whole roster, in the transaction that is about to change it.**
   *
   * The last-owner invariant spans the set (`roster.ts`), so the command reads
   * it here and checks it before writing — inside one transaction, so the set
   * it checks is the set it changes. Reading it outside would be a
   * time-of-check-to-time-of-use race with a very specific loss: two concurrent
   * demotions of two different owners, each seeing two, and an organization
   * left with none.
   */
  roster(org: OrgId): Promise<readonly RosterEntry[]>;
  list(org: OrgId): Promise<readonly Membership[]>;
  /** Every membership a user holds. What `identity` reads through its port. */
  forUser(userId: string): Promise<readonly Membership[]>;
  create(membership: Membership): Promise<void>;
  save(membership: Membership): Promise<void>;
  remove(id: MembershipId): Promise<void>;
}

export interface Invitations {
  byId(id: InvitationId): Promise<Invitation | undefined>;
  byFingerprint(fingerprint: string): Promise<Invitation | undefined>;
  pending(org: OrgId): Promise<readonly Invitation[]>;
  create(invitation: Invitation): Promise<void>;
  save(invitation: Invitation): Promise<void>;
}

/** Delivers an invitation. The context names what a message *is*. */
export interface InvitationMailer {
  send(
    to: string,
    org: { readonly id: string; readonly name: string },
    secret: string,
  ): Promise<void>;
}

export interface Work {
  readonly orgs: Organizations;
  readonly memberships: Memberships;
  readonly invitations: Invitations;
  publish(event: Event, provenance: Provenance): Promise<void>;
}

export interface Transactor {
  within<T>(work: (handle: Work) => Promise<T>): Promise<T>;
}

export interface OrgsDeps {
  readonly transactor: Transactor;
  readonly orgs: Organizations;
  readonly memberships: Memberships;
  readonly invitations: Invitations;
  readonly mailer: InvitationMailer;
  /**
   * Tags invitations. **`crypto`'s `Mac`, keyring-aware.**
   *
   * `tag` returns a `Result` because a keyring with no current key is a
   * configuration failure rather than an exception — and `verify` checks the
   * whole ring, so rotating the signing key does not invalidate invitations
   * already in flight. That is §4's *keyring-aware so rotation does not break
   * outstanding links*, and it is a property of the module rather than
   * something this context arranges.
   */
  readonly mac: Mac;
  readonly clock: { now(): Date };
  readonly ids: { uuid(): string };
  readonly random: Random;
  readonly publisher: Publisher;
  /** How long an invitation lives. Short: it is a standing offer in a mailbox. */
  readonly invitationTtlMs: number;
}
