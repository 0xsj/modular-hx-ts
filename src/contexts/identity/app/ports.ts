/**
 * The out-ports `identity` needs. **`app/` declares them; the root injects.**
 *
 * Rule `S8`: `app/` never imports `infra/`. Everything below is an interface
 * this context needs *somebody* to satisfy, and both `infra/memory` and
 * `infra/postgres` do — proved by one contract suite, not by two sets of tests.
 *
 * See `notes/domain/identity.md`.
 */

import { type Event } from '../../../shared/events/index.js';
import { type Provenance } from '../../../shared/provenance/index.js';
import {
  type ApiKey,
  type ApiKeyId,
  type Challenge,
  type ChallengeId,
  type Email,
  type Password,
  type PasswordHash,
  type Session,
  type SessionId,
  type User,
  type Purpose,
  type UserId,
} from '../domain/index.js';

/**
 * A page of users, as the store is asked for it.
 *
 * **Over-fetch by one**, which is how *is there more* is answered without a
 * second `count(*)` over the same predicate — `pagination`'s own rule, and the
 * reason `limit` here is the caller's limit rather than the row budget.
 */
export interface UserQuery {
  /** A substring match on address and display name. Absent lists everybody. */
  readonly q?: string;
  /**
   * Include disabled accounts. **Absent means no.**
   *
   * The directory shows people who can act. A disabled account is one an
   * administrator has taken out of circulation, and listing it alongside the
   * others is how somebody sends it work — the conformance corpus says the same
   * thing by declaring `users_total` and `users_visible` separately.
   *
   * `GET /v1/users/{id}` still returns it: a caller who already knows the id is
   * asking about a specific person, and answering 404 there would make a
   * disabled account indistinguishable from a deleted one.
   */
  readonly includeDisabled?: boolean;
  /** Rows to return. The adapter fetches one more to detect a next page. */
  readonly limit: number;
  /** Exclusive lower bound — `(created_at, id)` of the last row seen. */
  readonly after?: { readonly createdAt: Date; readonly id: string };
  /** Exclusive upper bound, for a backward page. */
  readonly before?: { readonly createdAt: Date; readonly id: string };
}

export interface Users {
  byId(id: UserId): Promise<User | undefined>;

  /**
   * List, ordered by `(created_at, id)` ascending. **Keyset, never offset.**
   *
   * The compound key is what makes the ordering total: `created_at` alone ties
   * for anything created in the same millisecond, and a cursor built on a
   * non-total order silently skips or repeats rows at the tie.
   *
   * A **backward** page returns rows in descending order from the bound; the
   * caller reverses them. Doing it here would make the adapter answer in an
   * order the query did not ask for.
   */
  list(query: UserQuery): Promise<readonly User[]>;
  /** The login lookup. `Email` is already normalized, so this is exact. */
  byEmail(address: Email): Promise<User | undefined>;

  /**
   * Insert a new user.
   *
   * **Uniqueness is the repository's job** — §2.1. A duplicate address raises
   * `Conflict`, and in PostgreSQL that arrives as a unique violation rather
   * than as a check this context performed: a read-then-insert has a window,
   * and the window is exactly the concurrent-signup case.
   */
  create(user: User): Promise<void>;

  /**
   * Write on `(id, baseVersion)`.
   *
   * A version mismatch raises `Conflict` — §7.4, and rule 7 of
   * `ARCHITECTURE.md` §3. The row moved under us and the caller has to decide.
   */
  save(user: User): Promise<void>;
}

export interface Sessions {
  byId(id: SessionId): Promise<Session | undefined>;

  /**
   * The per-request lookup. **Takes a fingerprint, never a token.**
   *
   * A port that accepted the raw token would be one implementation away from
   * storing it.
   */
  byFingerprint(fingerprint: string): Promise<Session | undefined>;

  create(session: Session): Promise<void>;
  save(session: Session): Promise<void>;

  /** Live sessions, for a caller listing their own. */
  listActive(userId: UserId, now: Date): Promise<readonly Session[]>;

  /**
   * Revoke every session for a user, optionally sparing one.
   *
   * **One call rather than a read-then-loop**, because the two cases that use
   * it are conformance cases 9 and 14 and both are security operations: a loop
   * that fails halfway leaves some sessions live, and a session that survives a
   * password reset is the whole thing the reset was for. Returns how many it
   * ended, which is what `PasswordChanged` reports.
   */
  revokeAll(userId: UserId, at: Date, except?: SessionId): Promise<number>;
}

export interface Challenges {
  /**
   * By id, which is what an emailed link carries.
   *
   * `secretlink` puts the identifier on the wire and authenticates it with a
   * MAC **before** any lookup, so a forged id never reaches this. The
   * fingerprint is then compared in constant time against the row.
   */
  byId(id: ChallengeId): Promise<Challenge | undefined>;
  byFingerprint(fingerprint: string): Promise<Challenge | undefined>;
  create(challenge: Challenge): Promise<void>;
  save(challenge: Challenge): Promise<void>;

  /**
   * Consume-or-expire every outstanding challenge of one purpose for a user.
   *
   * **Conformance case 14's second half**: a password reset revokes all
   * sessions **and the user's other outstanding reset links**. Without it, a
   * second link mailed an hour earlier is still live — and the attacker who
   * triggered it still has it.
   */
  expireOutstanding(
    userId: UserId,
    purpose: Purpose,
    at: Date,
  ): Promise<number>;

  /**
   * Already issued for this source event?
   *
   * §7.7: idempotency is **modelled, not middleware**. At-least-once delivery
   * means a subscriber sees duplicates, and a unique column makes that safe in
   * the domain.
   */
  bySourceEvent(eventId: string): Promise<Challenge | undefined>;
}

export interface ApiKeys {
  byFingerprint(fingerprint: string): Promise<ApiKey | undefined>;
  byId(id: ApiKeyId): Promise<ApiKey | undefined>;
  listFor(userId: UserId): Promise<readonly ApiKey[]>;
  create(key: ApiKey): Promise<void>;
  save(key: ApiKey): Promise<void>;
}

/**
 * Delivering the secret.
 *
 * A port rather than `mailer` directly, because *what the message says* is this
 * context's business and *how it is sent* is not. It also means conformance
 * case 15 — an unknown address gets the same 202 — is testable without a
 * mail server.
 */
export interface ChallengeMailer {
  send(
    to: Email,
    purpose: Purpose,
    secret: string,
    payload: string,
  ): Promise<void>;
}

/**
 * Password hashing. **An app-layer port, so the domain holds an opaque hash and
 * knows nothing about the algorithm.**
 *
 * Argon2id versus scrypt versus bcrypt is a wiring decision with an operational
 * cost profile, and a domain that named one would have to be edited to change
 * it.
 */
export interface Hasher {
  hash(password: Password): Promise<PasswordHash>;
  verify(hash: PasswordHash, password: Password): Promise<boolean>;

  /**
   * Is this stored hash below the current policy?
   *
   * **Verify-then-rehash is the accepted upgrade path** — collection decision
   * 0011 — and silent acceptance is not. A stored hash computed at a weaker
   * cost still *verifies*, because the parameters travel in the string; what
   * must not happen is nobody noticing.
   */
  needsRehash(hash: PasswordHash): boolean;

  /**
   * A hash of nothing, for the address that does not exist.
   *
   * **Conformance case 7's timing half.** A login that skips verification when
   * the user is unknown returns measurably faster, and that difference is an
   * enumeration oracle — an attacker learns which addresses are registered
   * without ever authenticating.
   *
   * Exposed as a value rather than a `verifyDummy()` method **on purpose**: the
   * command calls the same `verify` either way, so the two paths cannot drift
   * apart. A separate method is a separate code path, and a separate code path
   * is where the timing difference comes back.
   */
  readonly dummy: PasswordHash;
}

/**
 * A unit of work.
 *
 * **This is why `app/` never sees a `DB`.** `ARCHITECTURE.md` §4 requires the
 * outbox row to be written in the *same* transaction as the data write, which
 * means publishing needs the caller's transaction handle. Passing a `DB`
 * through the application layer would put SQL in every command signature; this
 * hands out repositories already bound to the transaction and a `publish` that
 * is bound to it too.
 *
 * The memory adapter satisfies it without a transaction and says so — it has
 * nothing to make atomic, which is honest rather than sloppy.
 */
export interface Work {
  readonly users: Users;
  readonly sessions: Sessions;
  readonly challenges: Challenges;
  readonly apiKeys: ApiKeys;
  /** Published inside this unit. Rolled back with it if it does not commit. */
  publish(event: Event, provenance: Provenance): Promise<void>;
}

export interface Transactor {
  within<T>(fn: (work: Work) => Promise<T>): Promise<T>;
}

/**
 * A caller's roles **inside organizations**. **The port this context declares
 * and does not implement.**
 *
 * > Identity learns a caller's org roles through a port the root wires, so
 * > neither context imports the other, and `ORGS_ENABLED=false` is a working
 * > configuration. — `CONTEXTS.md` §4
 *
 * **Declared by the consumer.** This is the first time in this repository that
 * one context needs something another has, and the shape of the answer matters
 * more than the feature: `identity` says what it needs, `orgs` satisfies it,
 * and `src/wire.ts` is the only file that sees both. Neither imports the other,
 * so `S6` holds — and it holds structurally rather than by inspection.
 *
 * **The absence of `orgs` is a valid configuration**, which is what proves the
 * seam is real rather than decorative. When nothing is wired, the root supplies
 * `noOrgs` below, every caller has no org roles, and the process boots and
 * serves. If that configuration did not work, the two contexts would be coupled
 * and the port would be a formality — `tests/smoke/orgs-disabled.test.ts`
 * executes it, because a requirement satisfied in prose and never run is a
 * requirement nobody has checked.
 */
export interface OrgRoles {
  /** Empty when the caller belongs to nothing, or when `orgs` is not wired. */
  of(
    userId: string,
  ): Promise<readonly { readonly orgId: string; readonly role: string }[]>;
}

/**
 * What the root wires when `ORGS_ENABLED=false`.
 *
 * **Empty, never a refusal.** A caller with no organizations is an ordinary
 * caller — the whole point of the flag is that the rest of the system does not
 * change shape — so this answers the same way `orgs` answers for somebody who
 * has joined nothing.
 */
export const noOrgs: OrgRoles = {
  of: () => Promise.resolve([]),
};
