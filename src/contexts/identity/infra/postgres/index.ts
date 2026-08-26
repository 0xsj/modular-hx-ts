/**
 * The PostgreSQL adapter. **`identity` infra.**
 *
 * The same contract suite the memory adapter passes, plus the two things only
 * a database provides: a **unique index** enforcing one address per user under
 * concurrency, and a **transaction** that makes the outbox row atomic with the
 * data write (`ARCHITECTURE.md` §4).
 *
 * **nolint:tenant — `identity` is not tenant-scoped, and that is the design.**
 *
 * `M3` requires every statement in a context adapter to filter by tenant,
 * because the violation *does not error — it returns other people's data*. That
 * is the right default and it does not apply here: a **user is global**, and
 * which organisations they belong to is `orgs`'s aggregate rather than a column
 * on `identity_users` (`../../../../CONTEXTS.md` §4 — multi-org membership,
 * role per scope). Scoping users by tenant would make one address unable to
 * belong to two organisations, which is the thing `orgs` exists to model.
 *
 * The marker is a reviewable line in a diff rather than a silent omission, and
 * it is **not a licence for the next context**: anything owning tenant-scoped
 * rows filters, or earns its own marker with its own reason.
 *
 * See `notes/domain/identity.md`.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import {
  type DB,
  type Postgres,
  asAppError,
  escapeLike,
} from '../../../../shared/postgres/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type ApiKey,
  type Challenge,
  type Email,
  type Purpose,
  type Session,
  type SessionState,
  type User,
  type UserState,
  ApiKey as ApiKeyAggregate,
  Challenge as ChallengeAggregate,
  Session as SessionAggregate,
  User as UserAggregate,
  apiKeyId,
  challengeId,
  passwordHash,
  role,
  sessionId,
  userId,
} from '../../domain/index.js';
import {
  type ApiKeys,
  type Challenges,
  type Sessions,
  type Transactor,
  type Users,
  type Work,
} from '../../app/ports.js';
import {
  API_KEYS_TABLE,
  CHALLENGES_TABLE,
  SESSIONS_TABLE,
  USERS_TABLE,
} from './schema.js';

interface UserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly password_hash: string | null;
  readonly roles: string[];
  readonly enabled: boolean;
  readonly version: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly token_fingerprint: string;
  readonly method: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly last_seen_at: Date;
  readonly revoked_at: Date | null;
  readonly version: number;
}

function toUser(row: UserRow): User {
  const state: UserState = {
    id: userId(row.id),
    email: row.email as Email,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    // Null means no password — the column's whole reason for being nullable.
    ...(row.password_hash === null
      ? {}
      : { passwordHash: passwordHash(row.password_hash) }),
    roles: row.roles.map((name) => role(name)),
    enabled: row.enabled,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return UserAggregate.from(state);
}

function toSession(row: SessionRow): Session {
  const state: SessionState = {
    id: sessionId(row.id),
    userId: userId(row.user_id),
    tokenFingerprint: row.token_fingerprint,
    // The column is text and the domain's union is closed. A row carrying
    // something else is a migration that went wrong, and the cast is where that
    // would surface rather than three layers up.
    method: row.method as SessionState['method'],
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    version: row.version,
  };
  return SessionAggregate.from(state);
}

const USER_COLUMNS =
  'id, email, display_name, password_hash, roles, enabled, version, created_at, updated_at';
const SESSION_COLUMNS =
  'id, user_id, token_fingerprint, method, issued_at, expires_at, last_seen_at, revoked_at, version';

export function postgresUsers(db: DB): Users {
  return {
    async byId(id) {
      const row = await db
        .queryRow<UserRow>(
          `select ${USER_COLUMNS} from ${USERS_TABLE} where id = $1`,
          [id],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'load a user');
        });
      return row === undefined ? undefined : toUser(row);
    },

    async byEmail(address) {
      const row = await db
        .queryRow<UserRow>(
          `select ${USER_COLUMNS} from ${USERS_TABLE} where email = $1`,
          [address],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'load a user by address');
        });
      return row === undefined ? undefined : toUser(row);
    },

    async list(query) {
      // **Every fragment is a bound parameter.** `q` is caller-supplied and
      // reaches a `like` pattern; `escapeLike` is not enough on its own,
      // because the pattern still has to arrive as a value rather than as SQL.
      const params: unknown[] = [];
      const bind = (value: unknown): string => {
        params.push(value);
        return `$${String(params.length)}`;
      };

      const where: string[] = [];
      // The directory shows people who can act — see `UserQuery`.
      if (query.includeDisabled !== true) where.push('enabled');
      if (query.q !== undefined && query.q !== '') {
        const pattern = bind(`%${escapeLike(query.q.toLowerCase())}%`);
        where.push(
          `(lower(email) like ${pattern} escape '\\'
            or lower(coalesce(display_name, '')) like ${pattern} escape '\\')`,
        );
      }

      const backward = query.before !== undefined;
      const bound = query.after ?? query.before;
      if (bound !== undefined) {
        // Row-value comparison, so the tuple is compared as a tuple. Spelling
        // it out as `a > x or (a = x and b > y)` is the version that is right
        // until somebody edits one half of it.
        where.push(
          `(created_at, id) ${backward ? '<' : '>'} (${bind(bound.createdAt)}, ${bind(bound.id)}::uuid)`,
        );
      }

      const rows = await db
        .query<UserRow>(
          `select ${USER_COLUMNS} from ${USERS_TABLE}
            ${where.length === 0 ? '' : `where ${where.join(' and ')}`}
            order by created_at ${backward ? 'desc' : 'asc'},
                     id ${backward ? 'desc' : 'asc'}
            limit ${bind(query.limit + 1)}`,
          params,
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'list users');
        });

      return rows.map(toUser);
    },

    async create(user) {
      const state = user.toState();
      try {
        await db.exec(
          `insert into ${USERS_TABLE}
             (id, email, display_name, password_hash, roles, enabled, version,
              created_at, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            state.id,
            state.email,
            state.displayName ?? null,
            state.passwordHash ?? null,
            state.roles,
            state.enabled,
            state.version,
            state.createdAt,
            state.updatedAt,
          ],
        );
      } catch (error) {
        // **The unique violation is the point.** `asAppError` maps SQLSTATE
        // 23505 to `Conflict`, so a concurrent signup loses at the index rather
        // than in a read this context performed — and conformance case 3 checks
        // that the `Kind` reaches the edge as a 409.
        throw asAppError(error, 'register a user');
      }
    },

    async save(user) {
      const state = user.toState();
      const updated = await db
        .exec(
          `update ${USERS_TABLE}
              set email = $1, display_name = $2, password_hash = $3,
                  roles = $4, enabled = $5, version = $6, updated_at = $7
            where id = $8 and version = $9`,
          [
            state.email,
            state.displayName ?? null,
            state.passwordHash ?? null,
            state.roles,
            state.enabled,
            state.version,
            state.updatedAt,
            state.id,
            user.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save a user');
        });

      if (updated === 0) {
        // Zero rows means the version moved. Raised directly rather than
        // squeezed through a SQLSTATE that does not describe it: this is not a
        // database error, it is the optimistic check doing its job. The `Kind`
        // matches what the memory adapter raises, which is what makes the
        // contract case a comparison rather than a coincidence.
        throw conflict(`user ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },
  };
}

export function postgresSessions(db: DB): Sessions {
  const one = async (
    sql: string,
    params: readonly unknown[],
    what: string,
  ): Promise<Session | undefined> => {
    const row = await db
      .queryRow<SessionRow>(sql, params)
      .catch((e: unknown) => {
        throw asAppError(e, what);
      });
    return row === undefined ? undefined : toSession(row);
  };

  return {
    byId: (id) =>
      one(
        `select ${SESSION_COLUMNS} from ${SESSIONS_TABLE} where id = $1`,
        [id],
        'load a session',
      ),

    byFingerprint: (fingerprint) =>
      one(
        `select ${SESSION_COLUMNS} from ${SESSIONS_TABLE}
          where token_fingerprint = $1`,
        [fingerprint],
        'load a session by fingerprint',
      ),

    async create(session) {
      const state = session.toState();
      try {
        await db.exec(
          `insert into ${SESSIONS_TABLE}
             (id, user_id, token_fingerprint, method, issued_at, expires_at,
              last_seen_at, revoked_at, version)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            state.id,
            state.userId,
            state.tokenFingerprint,
            state.method,
            state.issuedAt,
            state.expiresAt,
            state.lastSeenAt,
            state.revokedAt ?? null,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'create a session');
      }
    },

    async save(session) {
      const state = session.toState();
      const updated = await db
        .exec(
          `update ${SESSIONS_TABLE}
              set last_seen_at = $1, revoked_at = $2, version = $3
            where id = $4 and version = $5`,
          [
            state.lastSeenAt,
            state.revokedAt ?? null,
            state.version,
            state.id,
            session.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save a session');
        });

      if (updated === 0) {
        throw conflict(`session ${state.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
    },

    async listActive(owner, now) {
      const rows = await db
        .query<SessionRow>(
          `select ${SESSION_COLUMNS} from ${SESSIONS_TABLE}
            where user_id = $1 and revoked_at is null and expires_at > $2
            order by issued_at`,
          [owner, now],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'list sessions');
        });
      return rows.map(toSession);
    },

    async revokeAll(owner, at, except) {
      // **One statement, not a read-then-loop.** Both callers are security
      // operations — conformance cases 9 and 14 — and a loop that fails halfway
      // leaves some sessions live. `revoked_at is null` is what makes the count
      // *what it ended* rather than *what it found*.
      const updated = await db
        .exec(
          `update ${SESSIONS_TABLE}
              set revoked_at = $2, version = version + 1
            where user_id = $1
              and revoked_at is null
              and ($3::uuid is null or id <> $3)`,
          [owner, at, except ?? null],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'revoke sessions');
        });
      return updated;
    },
  };
}

interface ChallengeRow {
  readonly id: string;
  readonly user_id: string;
  readonly purpose: string;
  readonly secret_fingerprint: string;
  readonly tag: string;
  readonly payload: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly source_event_id: string | null;
  readonly version: number;
}

const CHALLENGE_COLUMNS =
  'id, user_id, purpose, secret_fingerprint, tag, payload, issued_at, expires_at, consumed_at, source_event_id, version';

function toChallenge(row: ChallengeRow): Challenge {
  return ChallengeAggregate.from({
    id: challengeId(row.id),
    userId: userId(row.user_id),
    purpose: row.purpose as Purpose,
    secretFingerprint: row.secret_fingerprint,
    tag: row.tag,
    payload: row.payload,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at }),
    ...(row.source_event_id === null
      ? {}
      : { sourceEventId: row.source_event_id }),
    version: row.version,
  });
}

export function postgresChallenges(db: DB): Challenges {
  const one = async (
    sql: string,
    params: readonly unknown[],
    what: string,
  ): Promise<Challenge | undefined> => {
    const row = await db
      .queryRow<ChallengeRow>(sql, params)
      .catch((e: unknown) => {
        throw asAppError(e, what);
      });
    return row === undefined ? undefined : toChallenge(row);
  };

  return {
    byId: (id) =>
      one(
        // nolint:tenant — a challenge is reached by an authenticated id
        `select ${CHALLENGE_COLUMNS} from ${CHALLENGES_TABLE} where id = $1`,
        [id],
        'load a challenge',
      ),

    byFingerprint: (fingerprint) =>
      one(
        `select ${CHALLENGE_COLUMNS} from ${CHALLENGES_TABLE}
          where secret_fingerprint = $1`,
        [fingerprint],
        'load a challenge',
      ),

    bySourceEvent: (eventId) =>
      one(
        `select ${CHALLENGE_COLUMNS} from ${CHALLENGES_TABLE}
          where source_event_id = $1`,
        [eventId],
        'load a challenge by source event',
      ),

    async create(challenge) {
      const state = challenge.toState();
      try {
        await db.exec(
          `insert into ${CHALLENGES_TABLE}
             (id, user_id, purpose, secret_fingerprint, tag, payload,
              issued_at, expires_at, consumed_at, source_event_id, version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            state.id,
            state.userId,
            state.purpose,
            state.secretFingerprint,
            state.tag,
            state.payload,
            state.issuedAt,
            state.expiresAt,
            state.consumedAt ?? null,
            state.sourceEventId ?? null,
            state.version,
          ],
        );
      } catch (error) {
        // The unique index on `source_event_id` is §7.7 doing its job: a
        // redelivered event loses here rather than issuing a second link.
        throw asAppError(error, 'issue a challenge');
      }
    },

    async save(challenge) {
      const state = challenge.toState();
      const updated = await db
        .exec(
          `update ${CHALLENGES_TABLE}
              set consumed_at = $1, version = $2
            where id = $3 and version = $4`,
          [
            state.consumedAt ?? null,
            state.version,
            state.id,
            challenge.baseVersion,
          ],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'save a challenge');
        });

      if (updated === 0) {
        // **The single-use guarantee, enforced by the database.** Two
        // concurrent consumes of one link both pass the aggregate's check and
        // only one can win this update -- conformance case 13 under
        // concurrency, which the in-process check alone cannot provide.
        throw conflict(`challenge ${state.id} was already consumed`);
      }
    },

    async expireOutstanding(owner, purpose, at) {
      // One statement, for the reason the session sweep is one: case 14 is a
      // security operation and a loop that fails halfway leaves a live link.
      return await db
        .exec(
          `update ${CHALLENGES_TABLE}
              set consumed_at = $3, version = version + 1
            where user_id = $1 and purpose = $2
              and consumed_at is null and expires_at > $3`,
          [owner, purpose, at],
        )
        .catch((error: unknown) => {
          throw asAppError(error, 'expire outstanding challenges');
        });
    },
  };
}

interface ApiKeyRow {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly scopes: string[];
  readonly created_at: Date;
  readonly last_used_at: Date | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly version: number;
}

const API_KEY_COLUMNS =
  'id, user_id, name, fingerprint, scopes, created_at, last_used_at, expires_at, revoked_at, version';

function toApiKey(row: ApiKeyRow): ApiKey {
  return ApiKeyAggregate.from({
    id: apiKeyId(row.id),
    userId: userId(row.user_id),
    name: row.name,
    fingerprint: row.fingerprint,
    scopes: row.scopes,
    createdAt: row.created_at,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    version: row.version,
  });
}

export function postgresApiKeys(db: DB): ApiKeys {
  const one = async (
    sql: string,
    params: readonly unknown[],
  ): Promise<ApiKey | undefined> => {
    const row = await db
      .queryRow<ApiKeyRow>(sql, params)
      .catch((e: unknown) => {
        throw asAppError(e, 'load an api key');
      });
    return row === undefined ? undefined : toApiKey(row);
  };

  return {
    byId: (id) =>
      one(`select ${API_KEY_COLUMNS} from ${API_KEYS_TABLE} where id = $1`, [
        id,
      ]),
    byFingerprint: (fingerprint) =>
      one(
        `select ${API_KEY_COLUMNS} from ${API_KEYS_TABLE} where fingerprint = $1`,
        [fingerprint],
      ),

    async listFor(owner) {
      const rows = await db
        .query<ApiKeyRow>(
          `select ${API_KEY_COLUMNS} from ${API_KEYS_TABLE}
            where user_id = $1 order by created_at`,
          [owner],
        )
        .catch((e: unknown) => {
          throw asAppError(e, 'list api keys');
        });
      return rows.map(toApiKey);
    },

    async create(key) {
      const state = key.toState();
      try {
        await db.exec(
          `insert into ${API_KEYS_TABLE}
             (id, user_id, name, fingerprint, scopes, created_at,
              last_used_at, expires_at, revoked_at, version)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            state.id,
            state.userId,
            state.name,
            state.fingerprint,
            state.scopes,
            state.createdAt,
            state.lastUsedAt ?? null,
            state.expiresAt ?? null,
            state.revokedAt ?? null,
            state.version,
          ],
        );
      } catch (error) {
        throw asAppError(error, 'create an api key');
      }
    },

    async save(key) {
      const state = key.toState();
      const updated = await db
        .exec(
          `update ${API_KEYS_TABLE}
              set last_used_at = $1, revoked_at = $2, version = $3
            where id = $4 and version = $5`,
          [
            state.lastUsedAt ?? null,
            state.revokedAt ?? null,
            state.version,
            state.id,
            key.baseVersion,
          ],
        )
        .catch((e: unknown) => {
          throw asAppError(e, 'save an api key');
        });

      if (updated === 0)
        throw conflict(`api key ${state.id} was modified`, {
          problem: 'version-conflict',
        });
    },
  };
}

export interface PostgresOptions {
  readonly db: Postgres;
  readonly publisher: Publisher;
}

export function postgresTransactor(options: PostgresOptions): Transactor {
  return {
    within: <T>(fn: (work: Work) => Promise<T>): Promise<T> =>
      options.db.withinTx(async (tx) => {
        const work: Work = {
          users: postgresUsers(tx),
          sessions: postgresSessions(tx),
          challenges: postgresChallenges(tx),
          apiKeys: postgresApiKeys(tx),
          // **`tx`, not the pool.** This argument is the whole reason the
          // outbox exists: the event row is written inside the caller's
          // transaction, so publishing is atomic with the data write. Passing
          // the pool here would restore the dual-write problem the outbox was
          // built to remove, silently and only under failure.
          publish: async (event: Event, provenance: Provenance) => {
            await options.publisher.publish(event, provenance, tx);
          },
        };
        return fn(work);
      }),
  };
}

/** Reads outside a unit of work, for `app/query`. */
export function postgresReaders(db: DB): {
  users: Users;
  sessions: Sessions;
  challenges: Challenges;
  apiKeys: ApiKeys;
} {
  return {
    users: postgresUsers(db),
    sessions: postgresSessions(db),
    challenges: postgresChallenges(db),
    apiKeys: postgresApiKeys(db),
  };
}
