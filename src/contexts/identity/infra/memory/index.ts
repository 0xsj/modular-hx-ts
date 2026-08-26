/**
 * The in-memory adapter. **`identity` infra.**
 *
 * `STORAGE=memory` needs zero external dependencies — invariant `I1` — and this
 * is what the unit suite and a single-process development run use.
 *
 * **What it cannot promise, and says so rather than faking:** atomicity. The
 * `Transactor` here runs the callback and keeps whatever it wrote; a failure
 * halfway leaves the earlier writes in place. That is a real difference from
 * the PostgreSQL adapter, and the contract suite deliberately does not assert
 * rollback — a suite that "proved" atomicity against three `Map`s would give
 * exactly the confidence that must not be given.
 *
 * See `notes/domain/identity.md`.
 */

import { conflict } from '../../../../shared/errors/index.js';
import { type Event, type Publisher } from '../../../../shared/events/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type ApiKey,
  type ApiKeyState,
  type Challenge,
  type ChallengeState,
  type Session,
  type SessionState,
  type User,
  type UserId,
  type UserState,
  ApiKey as ApiKeyAggregate,
  Challenge as ChallengeAggregate,
  Session as SessionAggregate,
  User as UserAggregate,
  type Email,
} from '../../domain/index.js';
import {
  type ApiKeys,
  type Challenges,
  type Sessions,
  type Transactor,
  type Users,
  type Work,
} from '../../app/ports.js';

/**
 * The stored rows.
 *
 * **States, not aggregates.** Keeping the aggregate would hand every caller the
 * same mutable object the store holds, so a mutation nobody saved would be
 * visible to the next reader — which the PostgreSQL adapter would never do, and
 * the contract suite would never catch because both adapters would be asked the
 * same questions and only one would be lying.
 */
export interface IdentityStore {
  readonly users: Map<string, UserState>;
  readonly sessions: Map<string, SessionState>;
  readonly challenges: Map<string, ChallengeState>;
  readonly apiKeys: Map<string, ApiKeyState>;
}

export function memoryStore(): IdentityStore {
  return {
    users: new Map(),
    sessions: new Map(),
    challenges: new Map(),
    apiKeys: new Map(),
  };
}

function memoryApiKeys(store: IdentityStore): ApiKeys {
  const hydrate = (state: ApiKeyState | undefined): ApiKey | undefined =>
    state === undefined ? undefined : ApiKeyAggregate.from(state);

  return {
    byId: (id) => Promise.resolve(hydrate(store.apiKeys.get(id))),
    byFingerprint: (fingerprint) =>
      Promise.resolve(
        hydrate(
          [...store.apiKeys.values()].find(
            (row) => row.fingerprint === fingerprint,
          ),
        ),
      ),
    listFor: (userId) =>
      Promise.resolve(
        [...store.apiKeys.values()]
          .filter((row) => row.userId === userId)
          .map((row) => ApiKeyAggregate.from(row)),
      ),
    create(key) {
      store.apiKeys.set(key.id, key.toState());
      return Promise.resolve();
    },
    save(key) {
      const current = store.apiKeys.get(key.id);
      if (current?.version !== key.baseVersion) {
        throw conflict(`api key ${key.id} was modified`, {
          problem: 'version-conflict',
        });
      }
      store.apiKeys.set(key.id, key.toState());
      return Promise.resolve();
    },
  };
}

function memoryChallenges(store: IdentityStore): Challenges {
  const hydrate = (state: ChallengeState | undefined): Challenge | undefined =>
    state === undefined ? undefined : ChallengeAggregate.from(state);

  return {
    byId: (id) => Promise.resolve(hydrate(store.challenges.get(id))),

    byFingerprint: (fingerprint) =>
      Promise.resolve(
        hydrate(
          [...store.challenges.values()].find(
            (row) => row.secretFingerprint === fingerprint,
          ),
        ),
      ),

    bySourceEvent: (eventId) =>
      Promise.resolve(
        hydrate(
          [...store.challenges.values()].find(
            (row) => row.sourceEventId === eventId,
          ),
        ),
      ),

    create(challenge) {
      const state = challenge.toState();
      if (
        state.sourceEventId !== undefined &&
        [...store.challenges.values()].some(
          (row) => row.sourceEventId === state.sourceEventId,
        )
      ) {
        // §7.7, as a unique constraint the memory adapter honours too: a
        // redelivered source event must not issue a second challenge.
        throw conflict('a challenge for that event already exists');
      }
      store.challenges.set(state.id, state);
      return Promise.resolve();
    },

    save(challenge) {
      const current = store.challenges.get(challenge.id);
      if (current?.version !== challenge.baseVersion) {
        throw conflict(`challenge ${challenge.id} was modified`, {
          problem: 'version-conflict',
        });
      }
      store.challenges.set(challenge.id, challenge.toState());
      return Promise.resolve();
    },

    expireOutstanding(userId, purpose, at) {
      let expired = 0;
      for (const state of store.challenges.values()) {
        if (state.userId !== userId || state.purpose !== purpose) continue;
        const challenge = ChallengeAggregate.from(state);
        if (!challenge.isUsableAt(at)) continue;
        // Consumed rather than deleted: an audit trail wants to know the link
        // existed and was retired, not that it never was.
        challenge.consume(at, purpose);
        store.challenges.set(challenge.id, challenge.toState());
        expired += 1;
      }
      return Promise.resolve(expired);
    },
  };
}

function memoryUsers(store: IdentityStore): Users {
  const byEmailIndex = (address: Email): UserState | undefined =>
    [...store.users.values()].find((row) => row.email === address);

  return {
    byId: (id) => Promise.resolve(read(store.users.get(id))),
    byEmail: (address) => Promise.resolve(read(byEmailIndex(address))),

    list(query) {
      const matches = (row: UserState): boolean => {
        if (!row.enabled && query.includeDisabled !== true) return false;
        if (query.q === undefined || query.q === '') return true;
        const needle = query.q.toLowerCase();
        return (
          row.email.toLowerCase().includes(needle) ||
          (row.displayName ?? '').toLowerCase().includes(needle)
        );
      };

      // `(created_at, id)` — total, which `created_at` alone is not: two rows
      // created in the same millisecond tie, and a cursor on a non-total order
      // skips or repeats at the tie.
      const key = (row: UserState): string =>
        `${row.createdAt.toISOString()}|${row.id}`;

      const rows = [...store.users.values()].filter(matches);
      const after = query.after;
      const before = query.before;

      const bounded = rows.filter((row) => {
        if (after !== undefined) {
          return key(row) > `${after.createdAt.toISOString()}|${after.id}`;
        }
        if (before !== undefined) {
          return key(row) < `${before.createdAt.toISOString()}|${before.id}`;
        }
        return true;
      });

      bounded.sort((a, b) =>
        before === undefined
          ? key(a).localeCompare(key(b))
          : key(b).localeCompare(key(a)),
      );

      // One more than asked for: the caller detects a further page from the
      // overshoot rather than from a second count.
      return Promise.resolve(
        bounded.slice(0, query.limit + 1).map((row) => UserAggregate.from(row)),
      );
    },

    create(user) {
      if (byEmailIndex(user.email) !== undefined) {
        // The same `Kind` the unique violation maps to in PostgreSQL, which is
        // what makes the contract case meaningful rather than tautological.
        throw conflict('that email address is already registered');
      }
      store.users.set(user.id, user.toState());
      return Promise.resolve();
    },

    save(user) {
      const current = store.users.get(user.id);
      if (current?.version !== user.baseVersion) {
        throw conflict(`user ${user.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
      store.users.set(user.id, user.toState());
      return Promise.resolve();
    },
  };

  function read(state: UserState | undefined): User | undefined {
    // Rehydrated per read, so two callers hold two aggregates over one row —
    // which is what makes the optimistic-concurrency case reachable.
    return state === undefined ? undefined : UserAggregate.from(state);
  }
}

function memorySessions(store: IdentityStore): Sessions {
  const hydrate = (state: SessionState | undefined): Session | undefined =>
    state === undefined ? undefined : SessionAggregate.from(state);

  const forUser = (userId: UserId): SessionState[] =>
    [...store.sessions.values()].filter((row) => row.userId === userId);

  return {
    byId: (id) => Promise.resolve(hydrate(store.sessions.get(id))),

    byFingerprint: (fingerprint) =>
      Promise.resolve(
        hydrate(
          [...store.sessions.values()].find(
            (row) => row.tokenFingerprint === fingerprint,
          ),
        ),
      ),

    create(session) {
      store.sessions.set(session.id, session.toState());
      return Promise.resolve();
    },

    save(session) {
      const current = store.sessions.get(session.id);
      if (current?.version !== session.baseVersion) {
        throw conflict(`session ${session.id} was modified by somebody else`, {
          problem: 'version-conflict',
        });
      }
      store.sessions.set(session.id, session.toState());
      return Promise.resolve();
    },

    listActive(userId, now) {
      const live = forUser(userId)
        .map((state) => SessionAggregate.from(state))
        .filter((session) => session.isValidAt(now));
      return Promise.resolve(live);
    },

    revokeAll(userId, at, except) {
      let revoked = 0;

      for (const state of forUser(userId)) {
        if (state.id === except) continue;
        const session = SessionAggregate.from(state);
        // Counts what it *ended*, not what it found: an already-revoked session
        // must not inflate the number `PasswordChanged` reports.
        if (!session.revoke(at).changed) continue;
        store.sessions.set(session.id, session.toState());
        revoked += 1;
      }

      return Promise.resolve(revoked);
    },
  };
}

export interface MemoryOptions {
  readonly store: IdentityStore;
  /** The bus. Memory mode publishes immediately; there is no transaction. */
  readonly publisher: Publisher;
}

export function memoryTransactor(options: MemoryOptions): Transactor {
  const work: Work = {
    users: memoryUsers(options.store),
    sessions: memorySessions(options.store),
    challenges: memoryChallenges(options.store),
    apiKeys: memoryApiKeys(options.store),
    publish: async (event: Event, provenance: Provenance) => {
      // No `db` argument: the memory bus has nothing to make atomic, and the
      // port's third parameter is optional precisely so this is honest rather
      // than a lie about a transaction that does not exist.
      await options.publisher.publish(event, provenance);
    },
  };

  return { within: (fn) => fn(work) };
}

/** Reads outside a unit of work, for `app/query`. */
export function memoryReaders(store: IdentityStore): {
  users: Users;
  sessions: Sessions;
  challenges: Challenges;
  apiKeys: ApiKeys;
} {
  return {
    users: memoryUsers(store),
    sessions: memorySessions(store),
    challenges: memoryChallenges(store),
    apiKeys: memoryApiKeys(store),
  };
}
