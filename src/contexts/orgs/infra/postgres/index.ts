/**
 * The PostgreSQL adapter. **`orgs` infra.**
 *
 * Runs the same contract suite the memory twin does — `I2`. Every write is on
 * `(id, version)`, so a concurrent change loses at the update rather than in a
 * read this adapter performed.
 *
 * **`nolint:tenant` — this context is not tenant-scoped.** `M3` requires every
 * statement in a context's `infra/postgres/` to filter by tenant. An
 * organization *is* the scope here: memberships are reached through an org id
 * the caller has already been proved a member of, and adding a tenant column
 * would be a second, weaker fence beside a stronger one. When `tenant` is wired
 * for real this becomes a real question; today the process is single-tenant and
 * a tenant filter would be a column with one value in it.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import {
  type DB,
  type Postgres,
  asAppError,
} from '../../../../shared/postgres/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type InvitationId,
  type MembershipId,
  type OrgId,
  type OrgRole,
  type RosterEntry,
  Invitation,
  Membership,
  Organization,
  invitationId,
  membershipId,
  orgId,
} from '../../domain/index.js';
import {
  type Invitations,
  type Memberships,
  type Organizations,
  type Transactor,
  type Work,
} from '../../app/ports.js';
import { INVITATIONS_TABLE, MEMBERSHIPS_TABLE, ORGS_TABLE } from './schema.js';

interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly archived_at: Date | null;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface MemberRow {
  readonly id: string;
  readonly org_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly joined_at: Date;
  readonly version: number;
}

interface InviteRow {
  readonly id: string;
  readonly org_id: string;
  readonly email: string;
  readonly role: string;
  readonly secret_fingerprint: string;
  readonly tag: string;
  readonly invited_by: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
  readonly version: number;
}

const ORG_COLUMNS =
  'id, name, slug, archived_at, version, created_at, updated_at';
const MEMBER_COLUMNS = 'id, org_id, user_id, role, joined_at, version';
const INVITE_COLUMNS =
  'id, org_id, email, role, secret_fingerprint, tag, invited_by, issued_at, expires_at, consumed_at, revoked_at, version';

function toOrg(row: OrgRow): Organization {
  return Organization.from({
    id: orgId(row.id),
    name: row.name,
    slug: row.slug,
    ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toMember(row: MemberRow): Membership {
  return Membership.from({
    id: membershipId(row.id),
    orgId: orgId(row.org_id),
    userId: row.user_id,
    // The column is text and the domain's union is closed. A row carrying
    // something else is a corrupt row, and the cast is where that is stated.
    role: row.role as OrgRole,
    joinedAt: row.joined_at,
    version: row.version,
  });
}

function toInvitation(row: InviteRow): Invitation {
  return Invitation.from({
    id: invitationId(row.id),
    orgId: orgId(row.org_id),
    email: row.email,
    role: row.role as OrgRole,
    secretFingerprint: row.secret_fingerprint,
    tag: row.tag,
    invitedBy: row.invited_by,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    version: row.version,
  });
}

export function postgresOrgs(db: DB): Organizations {
  return {
    async byId(id) {
      const row = await db
        .queryRow<OrgRow>(
          `select ${ORG_COLUMNS} from ${ORGS_TABLE} where id = $1`, // nolint:tenant — an organization IS the scope
          [id],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'read an organization');
        });
      return row === undefined ? undefined : toOrg(row);
    },

    async bySlug(named) {
      const row = await db
        .queryRow<OrgRow>(
          `select ${ORG_COLUMNS} from ${ORGS_TABLE} where slug = $1`, // nolint:tenant — an organization IS the scope
          [named],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'read an organization');
        });
      return row === undefined ? undefined : toOrg(row);
    },

    async forUser(userId) {
      const rows = await db
        .query<OrgRow>(
          // nolint:tenant — scoped by membership, which is stronger than a tenant column
          `select ${ORG_COLUMNS.split(', ')
            .map((c) => `o.${c}`)
            .join(', ')}
             from ${ORGS_TABLE} o
             join ${MEMBERSHIPS_TABLE} m on m.org_id = o.id
            where m.user_id = $1
            order by o.created_at asc, o.id asc`,
          [userId],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'list organizations');
        });
      return rows.map(toOrg);
    },

    async create(org) {
      const state = org.toState();
      try {
        await db.exec(
          // nolint:tenant — an organization IS the scope
          `insert into ${ORGS_TABLE}
             (id, name, slug, archived_at, version, created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            state.id,
            state.name,
            state.slug,
            state.archivedAt ?? null,
            state.version,
            state.createdAt,
            state.updatedAt,
          ],
        );
      } catch (error) {
        // The unique violation is the point: a concurrent found loses at the
        // index rather than in a read this command performed.
        throw asAppError(error, 'found an organization');
      }
    },

    async save(org) {
      const state = org.toState();
      const updated = await db
        .exec(
          // nolint:tenant — an organization IS the scope
          `update ${ORGS_TABLE}
              set name = $1, slug = $2, archived_at = $3, version = $4,
                  updated_at = $5
            where id = $6 and version = $7`,
          [
            state.name,
            state.slug,
            state.archivedAt ?? null,
            state.version,
            state.updatedAt,
            state.id,
            org.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save an organization');
        });

      if (updated === 0) {
        throw conflict(
          `organization ${state.id} was modified by somebody else`,
          {
            problem: 'version-conflict',
          },
        );
      }
    },
  };
}

export function postgresMemberships(db: DB): Memberships {
  return {
    async byId(id: MembershipId) {
      const row = await db.queryRow<MemberRow>(
        `select ${MEMBER_COLUMNS} from ${MEMBERSHIPS_TABLE} where id = $1`, // nolint:tenant — reached through an org the caller belongs to
        [id],
      );
      return row === undefined ? undefined : toMember(row);
    },

    async of(org: OrgId, userId: string) {
      const row = await db.queryRow<MemberRow>(
        // nolint:tenant — the org id IS the scope
        `select ${MEMBER_COLUMNS} from ${MEMBERSHIPS_TABLE}
          where org_id = $1 and user_id = $2`,
        [org, userId],
      );
      return row === undefined ? undefined : toMember(row);
    },

    async roster(org: OrgId): Promise<readonly RosterEntry[]> {
      // **Read inside the transaction that is about to change it**, which is
      // what makes the last-owner check correct rather than probable — see
      // `domain/roster.ts`. `for update` locks the rows the check reasons
      // about, so two concurrent demotions of two different owners cannot each
      // see two.
      const rows = await db.query<{ user_id: string; role: string }>(
        // nolint:tenant — the org id IS the scope
        `select user_id, role from ${MEMBERSHIPS_TABLE}
          where org_id = $1
          for update`,
        [org],
      );
      return rows.map((row) => ({
        userId: row.user_id,
        role: row.role as OrgRole,
      }));
    },

    async list(org: OrgId) {
      const rows = await db.query<MemberRow>(
        // nolint:tenant — the org id IS the scope
        `select ${MEMBER_COLUMNS} from ${MEMBERSHIPS_TABLE}
          where org_id = $1
          order by joined_at asc, id asc`,
        [org],
      );
      return rows.map(toMember);
    },

    async forUser(userId: string) {
      const rows = await db.query<MemberRow>(
        // nolint:tenant — a user's own memberships across every org
        `select ${MEMBER_COLUMNS} from ${MEMBERSHIPS_TABLE} where user_id = $1`,
        [userId],
      );
      return rows.map(toMember);
    },

    async create(membership) {
      const state = membership.toState();
      try {
        await db.exec(
          // nolint:tenant — the org id IS the scope
          `insert into ${MEMBERSHIPS_TABLE}
             (id, org_id, user_id, role, joined_at, version)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            state.id,
            state.orgId,
            state.userId,
            state.role,
            state.joinedAt,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'add a member');
      }
    },

    async save(membership) {
      const state = membership.toState();
      const updated = await db.exec(
        // nolint:tenant — the org id IS the scope
        `update ${MEMBERSHIPS_TABLE}
            set role = $1, version = $2
          where id = $3 and version = $4`,
        [state.role, state.version, state.id, membership.baseVersion],
      );
      if (updated === 0) {
        throw conflict(`membership ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },

    async remove(id: MembershipId) {
      // nolint:tenant — reached through an org the caller belongs to
      await db.exec(`delete from ${MEMBERSHIPS_TABLE} where id = $1`, [id]);
    },
  };
}

export function postgresInvitations(db: DB): Invitations {
  return {
    async byId(id: InvitationId) {
      const row = await db.queryRow<InviteRow>(
        `select ${INVITE_COLUMNS} from ${INVITATIONS_TABLE} where id = $1`, // nolint:tenant — scoped by the caller's org membership
        [id],
      );
      return row === undefined ? undefined : toInvitation(row);
    },

    async byFingerprint(fingerprint: string) {
      const row = await db.queryRow<InviteRow>(
        // nolint:tenant — possession of the secret IS the scope
        `select ${INVITE_COLUMNS} from ${INVITATIONS_TABLE}
          where secret_fingerprint = $1`,
        [fingerprint],
      );
      return row === undefined ? undefined : toInvitation(row);
    },

    async pending(org: OrgId) {
      const rows = await db.query<InviteRow>(
        // nolint:tenant — the org id IS the scope
        `select ${INVITE_COLUMNS} from ${INVITATIONS_TABLE}
          where org_id = $1 and consumed_at is null and revoked_at is null
          order by issued_at desc`,
        [org],
      );
      return rows.map(toInvitation);
    },

    async create(invitation) {
      const state = invitation.toState();
      try {
        await db.exec(
          // nolint:tenant — the org id IS the scope
          `insert into ${INVITATIONS_TABLE}
             (id, org_id, email, role, secret_fingerprint, tag, invited_by,
              issued_at, expires_at, consumed_at, revoked_at, version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            state.id,
            state.orgId,
            state.email,
            state.role,
            state.secretFingerprint,
            state.tag,
            state.invitedBy,
            state.issuedAt,
            state.expiresAt,
            state.consumedAt ?? null,
            state.revokedAt ?? null,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'issue an invitation');
      }
    },

    async save(invitation) {
      const state = invitation.toState();
      const updated = await db.exec(
        // nolint:tenant — the org id IS the scope
        `update ${INVITATIONS_TABLE}
            set consumed_at = $1, revoked_at = $2, version = $3
          where id = $4 and version = $5`,
        [
          state.consumedAt ?? null,
          state.revokedAt ?? null,
          state.version,
          state.id,
          invitation.baseVersion,
        ],
      );
      if (updated === 0) {
        throw conflict(`invitation ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },
  };
}

export function postgresReaders(db: Postgres): {
  orgs: Organizations;
  memberships: Memberships;
  invitations: Invitations;
} {
  return {
    orgs: postgresOrgs(db),
    memberships: postgresMemberships(db),
    invitations: postgresInvitations(db),
  };
}

export function postgresTransactor(options: {
  db: Postgres;
  publisher: Publisher;
}): Transactor {
  const { db, publisher } = options;

  return {
    within<T>(work: (handle: Work) => Promise<T>): Promise<T> {
      return db.withinTx(async (tx) => {
        const handle: Work = {
          orgs: postgresOrgs(tx),
          memberships: postgresMemberships(tx),
          invitations: postgresInvitations(tx),
          // **The outbox row in the same transaction as the data write** —
          // `ARCHITECTURE.md` §4. Passing `tx` is the whole point of `Work`.
          publish: async (event: Event, provenance: Provenance) => {
            await publisher.publish(event, provenance, tx);
          },
        };
        return work(handle);
      });
    },
  };
}
