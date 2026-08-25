/**
 * Domain events. **`identity` domain, and a cross-context contract.**
 *
 * `../../../../CONTEXTS.md` §2.5 specifies the names and the shape, because
 * **`audit` imports no context and cannot look anything up.** Everything it
 * records has to be on the event, and it is queryable by actor, subject, event,
 * event prefix, correlation and time. That makes naming a contract rather than
 * this context's private choice.
 *
 * **`<context>.<aggregate>.<past-tense-verb>`**, lowercase, dot-separated.
 * Dots are the prefix boundary, so `identity.` and `identity.user.` are both
 * queries. Underscores inside a segment; never camel case. **Past tense**,
 * because an event is a fact that already happened — a name in the imperative
 * is a command that escaped.
 *
 * **Every event carries its subject in its own payload.** The actor rides the
 * envelope's provenance and is never re-derived by a subscriber. Subject and
 * actor differ more often than they look — an administrator disabling somebody
 * else, a system job expiring a session — and a record that assumes them equal
 * is wrong exactly when it matters.
 *
 * See `notes/domain/identity.md`.
 */

import { type SessionId, type UserId } from './ids.js';

export const IdentityEvent = {
  UserRegistered: 'identity.user.registered',
  UserAuthenticated: 'identity.user.authenticated',
  AuthenticationFailed: 'identity.user.authentication_failed',
  UserDisabled: 'identity.user.disabled',
  UserEnabled: 'identity.user.enabled',
  UserEmailChanged: 'identity.user.email_changed',
  PasswordChanged: 'identity.user.password_changed',
  RoleGranted: 'identity.user.role_granted',
  RoleRevoked: 'identity.user.role_revoked',
  ChallengeIssued: 'identity.challenge.issued',
  ChallengeConsumed: 'identity.challenge.consumed',
  EmailVerified: 'identity.user.email_verified',
  ApiKeyCreated: 'identity.api_key.created',
  ApiKeyRevoked: 'identity.api_key.revoked',
  SessionCreated: 'identity.session.created',
  SessionRevoked: 'identity.session.revoked',
} as const;

export type IdentityEvent = (typeof IdentityEvent)[keyof typeof IdentityEvent];

/**
 * What every payload here carries.
 *
 * `subject` is the **user acted upon**, which is not the actor. An
 * administrator disabling somebody else produces `subject: <them>` with
 * `actor: <the administrator>` on the envelope, and `audit` needs both to
 * answer *who did what to whom*.
 */
interface UserSubject {
  readonly subject: UserId;
}

export interface UserRegistered extends UserSubject {
  readonly email: string;
}

export interface UserAuthenticated extends UserSubject {
  readonly sessionId: SessionId;
  /** Which method got them in. The convergence point's whole output. */
  readonly method: string;
}

/**
 * **Fires only for existing users** — §2.2.
 *
 * An unknown address is unverified input: putting it on the bus writes an
 * attacker's guesses into `audit` and hands anyone with read access a list of
 * addresses somebody tried. Unknown addresses are counted as a metric instead,
 * where a number carries the signal and the string does not.
 */
export interface AuthenticationFailed extends UserSubject {
  readonly reason: 'bad_password' | 'disabled';
}

/**
 * No payload beyond the subject.
 *
 * Type aliases rather than empty interfaces: an interface with no members is
 * its supertype, and lint says so. The names still earn their place — a
 * subscriber writes `UserDisabled` and means it.
 */
export type UserDisabled = UserSubject;
export type UserEnabled = UserSubject;

export interface UserEmailChanged extends UserSubject {
  readonly email: string;
}

/** No payload beyond the subject: a password change is a fact, not a value. */
export interface PasswordChanged extends UserSubject {
  /** How many other sessions this ended — conformance case 9. */
  readonly revokedSessions: number;
}

export interface RoleGranted extends UserSubject {
  readonly role: string;
}

export interface RoleRevoked extends UserSubject {
  readonly role: string;
}

export interface ChallengeIssued extends UserSubject {
  readonly challengeId: string;
  readonly purpose: string;
}

export interface ChallengeConsumed extends UserSubject {
  readonly challengeId: string;
  readonly purpose: string;
}

export interface ApiKeyCreated extends UserSubject {
  readonly keyId: string;
  readonly name: string;
  readonly scopes: readonly string[];
}

export interface ApiKeyRevoked extends UserSubject {
  readonly keyId: string;
}

export interface SessionCreated extends UserSubject {
  readonly sessionId: SessionId;
  readonly method: string;
  readonly expiresAt: string;
}

export interface SessionRevoked extends UserSubject {
  readonly sessionId: SessionId;
  /**
   * Why, because the answer differs and `audit` cannot infer it.
   *
   * A logout, a password change ending every other session, an administrator
   * disabling an account, and a job expiring a stale one all produce this
   * event, and only the producer knows which.
   */
  readonly reason: 'logout' | 'password_changed' | 'disabled' | 'expired';
}
