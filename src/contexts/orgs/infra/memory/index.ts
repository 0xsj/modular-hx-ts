/**
 * The in-memory store. **`orgs` infra.**
 *
 * `STORAGE=memory` is a real mode — invariant `I1` — not a demo: the whole
 * application runs on this with no external dependency, and it passes the same
 * contract suite the PostgreSQL adapter does.
 *
 * **Every refusal is a rejection, not a throw**, and the twin had to be told.
 * A port method declared `Promise<void>` that throws *synchronously* is one a
 * caller cannot `.catch()` — and the difference from the PostgreSQL adapter,
 * which is async by construction, is invisible until somebody writes
 * `save(x).catch(...)` and the process dies instead of recovering. `I2` did not
 * catch it because no contract case used `.rejects` on the twin.
 *
 * **The transaction is a snapshot-and-swap**, which is enough for the one
 * property the contract suite asks of it: a `within` that throws leaves the
 * store as it found it. It is not enough for concurrency, and it does not
 * pretend to be — JavaScript runs each callback to completion, so there is no
 * interleaving to protect against in one process, and the shared-store case is
 * the PostgreSQL adapter\'s to prove.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type InvitationId,
  type InvitationState,
  type MembershipId,
  type MembershipState,
  type OrgId,
  type OrgState,
  type RosterEntry,
  Invitation,
  Membership,
  Organization,
} from '../../domain/index.js';
import {
  type Invitations,
  type Memberships,
  type Organizations,
  type Transactor,
  type Work,
} from '../../app/ports.js';

export interface OrgStore {
  readonly orgs: Map<string, OrgState>;
  readonly memberships: Map<string, MembershipState>;
  readonly invitations: Map<string, InvitationState>;
}

export function memoryStore(): OrgStore {
  return { orgs: new Map(), memberships: new Map(), invitations: new Map() };
}

function memoryOrgs(store: OrgStore): Organizations {
  const all = (): readonly OrgState[] => [...store.orgs.values()];

  return {
    byId: (id) => {
      const row = store.orgs.get(id);
      return Promise.resolve(
        row === undefined ? undefined : Organization.from(row),
      );
    },
    bySlug: (named) => {
      const row = all().find((one) => one.slug === named);
      return Promise.resolve(
        row === undefined ? undefined : Organization.from(row),
      );
    },
    forUser: (userId) => {
      const mine = new Set(
        [...store.memberships.values()]
          .filter((one) => one.userId === userId)
          .map((one) => one.orgId as string),
      );
      return Promise.resolve(
        all()
          .filter((one) => mine.has(one.id))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((one) => Organization.from(one)),
      );
    },
    create(org) {
      const state = org.toState();
      // Uniqueness is the repository\'s — the same rule the PostgreSQL unique
      // index enforces, so the contract case is a comparison rather than a
      // coincidence.
      if (all().some((one) => one.slug === state.slug)) {
        return Promise.reject(
          conflict(`an organization already uses the slug ${state.slug}`),
        );
      }
      store.orgs.set(state.id, state);
      return Promise.resolve();
    },
    save(org) {
      const state = org.toState();
      const current = store.orgs.get(state.id);
      if (current?.version !== org.baseVersion) {
        throw conflict(
          `organization ${state.id} was modified by somebody else`,
          {
            problem: 'version-conflict',
          },
        );
      }
      store.orgs.set(state.id, state);
      return Promise.resolve();
    },
  };
}

function memoryMemberships(store: OrgStore): Memberships {
  const all = (): readonly MembershipState[] => [...store.memberships.values()];
  const inOrg = (org: OrgId): readonly MembershipState[] =>
    all().filter((one) => one.orgId === org);

  return {
    byId: (id) => {
      const row = store.memberships.get(id);
      return Promise.resolve(
        row === undefined ? undefined : Membership.from(row),
      );
    },
    of: (org, userId) => {
      const row = inOrg(org).find((one) => one.userId === userId);
      return Promise.resolve(
        row === undefined ? undefined : Membership.from(row),
      );
    },
    roster: (org) =>
      Promise.resolve(
        inOrg(org).map((one): RosterEntry => ({
          userId: one.userId,
          role: one.role,
        })),
      ),
    list: (org) =>
      Promise.resolve(
        [...inOrg(org)]
          .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())
          .map((one) => Membership.from(one)),
      ),
    forUser: (userId) =>
      Promise.resolve(
        all()
          .filter((one) => one.userId === userId)
          .map((one) => Membership.from(one)),
      ),
    create(membership) {
      const state = membership.toState();
      if (inOrg(state.orgId).some((one) => one.userId === state.userId)) {
        return Promise.reject(
          conflict('that user is already a member of this organization'),
        );
      }
      store.memberships.set(state.id, state);
      return Promise.resolve();
    },
    save(membership) {
      const state = membership.toState();
      const current = store.memberships.get(state.id);
      if (current?.version !== membership.baseVersion) {
        return Promise.reject(
          conflict(`membership ${state.id} was modified by somebody else`, {
            problem: 'version-conflict',
          }),
        );
      }
      store.memberships.set(state.id, state);
      return Promise.resolve();
    },
    // Idempotent: removing what is not there is not an error.
    remove: (id: MembershipId) => {
      store.memberships.delete(id);
      return Promise.resolve();
    },
  };
}

function memoryInvitations(store: OrgStore): Invitations {
  const all = (): readonly InvitationState[] => [...store.invitations.values()];

  return {
    byId: (id: InvitationId) => {
      const row = store.invitations.get(id);
      return Promise.resolve(
        row === undefined ? undefined : Invitation.from(row),
      );
    },
    byFingerprint: (fingerprint) => {
      const row = all().find((one) => one.secretFingerprint === fingerprint);
      return Promise.resolve(
        row === undefined ? undefined : Invitation.from(row),
      );
    },
    pending: (org) =>
      Promise.resolve(
        all()
          .filter(
            (one) =>
              one.orgId === org &&
              one.consumedAt === undefined &&
              one.revokedAt === undefined,
          )
          .map((one) => Invitation.from(one)),
      ),
    create(invitation) {
      const state = invitation.toState();
      store.invitations.set(state.id, state);
      return Promise.resolve();
    },
    save(invitation) {
      const state = invitation.toState();
      const current = store.invitations.get(state.id);
      if (current?.version !== invitation.baseVersion) {
        return Promise.reject(
          conflict(`invitation ${state.id} was modified by somebody else`, {
            problem: 'version-conflict',
          }),
        );
      }
      store.invitations.set(state.id, state);
      return Promise.resolve();
    },
  };
}

export function memoryReaders(store: OrgStore): {
  orgs: Organizations;
  memberships: Memberships;
  invitations: Invitations;
} {
  return {
    orgs: memoryOrgs(store),
    memberships: memoryMemberships(store),
    invitations: memoryInvitations(store),
  };
}

export function memoryTransactor(options: {
  store: OrgStore;
  publisher: Publisher;
}): Transactor {
  const { store, publisher } = options;

  return {
    async within<T>(work: (handle: Work) => Promise<T>): Promise<T> {
      const snapshot = {
        orgs: new Map(store.orgs),
        memberships: new Map(store.memberships),
        invitations: new Map(store.invitations),
      };

      const handle: Work = {
        ...memoryReaders(store),
        publish: async (event: Event, provenance: Provenance) => {
          // No `db` argument: the memory bus has nothing to make atomic, and
          // the port\'s third parameter is optional precisely so this is honest
          // rather than a lie about durability.
          await publisher.publish(event, provenance);
        },
      };

      try {
        return await work(handle);
      } catch (error) {
        store.orgs.clear();
        for (const [k, v] of snapshot.orgs) store.orgs.set(k, v);
        store.memberships.clear();
        for (const [k, v] of snapshot.memberships) store.memberships.set(k, v);
        store.invitations.clear();
        for (const [k, v] of snapshot.invitations) {
          store.invitations.set(k, v);
        }
        throw error;
      }
    },
  };
}
