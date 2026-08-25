/**
 * The `Session` aggregate. **`identity` domain.**
 *
 * **Two aggregates, not `User.Sessions`** — §2.2. Sessions are written far more
 * often than users and have their own lifecycle; the only thing crossing the
 * boundary is a foreign key. Modelled as a collection on `User`, every login
 * would bump the user's version, every `Touch` would contend with a role grant,
 * and the optimistic-concurrency token would be useless for the thing it is
 * actually for.
 *
 * **Fixed TTL plus revocation, not JWT** — §2.2. Revocation is instant and
 * per-session, roles are read per request rather than baked into a token
 * (conformance case 12), and there is no key distribution problem. The cost is
 * a store read per request, which is the trade this collection takes.
 *
 * **Only a fingerprint is stored.** The raw token exists in the login response
 * and nowhere else, so a database dump yields no usable sessions.
 *
 * See `notes/domain/identity.md`.
 */

import { unauthenticated } from '../../../shared/errors/index.js';
import { type SessionId, type UserId } from './ids.js';

/**
 * How the session was created.
 *
 * **The reason this field exists before there is a second value** — §2.2. Every
 * authentication method converges on `Session.issue`, and each names itself
 * here. Added later, it would have to be backfilled with a guess for every row
 * already written.
 */
export const AuthMethod = {
  Password: 'password',
  /** A single-use emailed link. The second method, and it lands in slice 3. */
  MagicLink: 'magic_link',
} as const;

export type AuthMethod = (typeof AuthMethod)[keyof typeof AuthMethod];

export interface SessionState {
  readonly id: SessionId;
  readonly userId: UserId;
  /** `sha256:` of the raw token. Never the token. */
  readonly tokenFingerprint: string;
  readonly method: AuthMethod;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt?: Date | undefined;
  readonly version: number;
}

/** At most once a minute — §2.1. */
const TOUCH_INTERVAL_MS = 60_000;

export class Session {
  #lastSeenAt: Date;
  #revokedAt: Date | undefined;
  #version: number;

  readonly id: SessionId;
  readonly userId: UserId;
  readonly tokenFingerprint: string;
  readonly method: AuthMethod;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly baseVersion: number;

  private constructor(state: SessionState) {
    this.id = state.id;
    this.userId = state.userId;
    this.tokenFingerprint = state.tokenFingerprint;
    this.method = state.method;
    this.issuedAt = state.issuedAt;
    this.expiresAt = state.expiresAt;
    this.baseVersion = state.version;

    this.#lastSeenAt = state.lastSeenAt;
    this.#revokedAt = state.revokedAt;
    this.#version = state.version;
  }

  /**
   * **The convergence point.** Every authentication method ends here.
   *
   * Password today; SSO, MFA and passkeys later. Each supplies a different
   * `method` and nothing else differs — which is what makes them additive.
   * Built now, with exactly one caller, because by the time there are three
   * each will have grown its own way of creating a session and the merge is a
   * rewrite (§2.2).
   */
  static issue(
    id: SessionId,
    userId: UserId,
    tokenFingerprint: string,
    method: AuthMethod,
    at: Date,
    expiresAt: Date,
  ): Session {
    return new Session({
      id,
      userId,
      tokenFingerprint,
      method,
      issuedAt: at,
      expiresAt,
      lastSeenAt: at,
      version: 1,
    });
  }

  static from(state: SessionState): Session {
    return new Session(state);
  }

  get lastSeenAt(): Date {
    return this.#lastSeenAt;
  }
  get revokedAt(): Date | undefined {
    return this.#revokedAt;
  }
  get version(): number {
    return this.#version;
  }

  /**
   * **Revoked beats expired** — §2.1.
   *
   * Order matters for the reason it usually does: an operator revoking a
   * session that had already expired wants the record to say *revoked*, and a
   * report counting expiries should not include it. Checking expiry first makes
   * the revocation invisible in exactly the case somebody is looking for it.
   */
  isValidAt(now: Date): boolean {
    if (this.#revokedAt !== undefined) return false;
    return now.getTime() < this.expiresAt.getTime();
  }

  /** The one refusal, so every caller produces the same 401. */
  assertValidAt(now: Date): void {
    if (!this.isValidAt(now)) {
      throw unauthenticated('this session is no longer valid');
    }
  }

  revoke(at: Date): { readonly changed: boolean } {
    if (this.#revokedAt !== undefined) return { changed: false };
    this.#revokedAt = at;
    this.#version += 1;
    return { changed: true };
  }

  /**
   * Record that the session was used — **throttled to at most once a minute**
   * (§2.1), from the injected clock.
   *
   * Unthrottled this is a write on **every authenticated request**, which turns
   * a read-mostly table into the busiest write in the system and makes every
   * request contend with itself. Last-seen is telemetry: a minute of staleness
   * costs nothing, and `RESILIENCE.md` §1 already classifies a failing touch as
   * fail-open for the same reason.
   */
  touch(now: Date): { readonly changed: boolean } {
    if (now.getTime() - this.#lastSeenAt.getTime() < TOUCH_INTERVAL_MS) {
      return { changed: false };
    }
    this.#lastSeenAt = now;
    this.#version += 1;
    return { changed: true };
  }

  toState(): SessionState {
    return {
      id: this.id,
      userId: this.userId,
      tokenFingerprint: this.tokenFingerprint,
      method: this.method,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      lastSeenAt: this.#lastSeenAt,
      ...(this.#revokedAt === undefined ? {} : { revokedAt: this.#revokedAt }),
      version: this.#version,
    };
  }
}
