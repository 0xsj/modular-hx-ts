/**
 * The `User` aggregate. **`identity` domain.**
 *
 * **A user is not their credentials** — §2.2's first and most load-bearing
 * decision. `passwordHash` is optional, and a user with none is a normal user
 * rather than a broken one. Everything about SSO, passkeys and MFA being
 * additive rather than a rewrite follows from that single `| undefined`.
 *
 * **Every mutation bumps `version` and `updatedAt`** (§2.1). `version` is the
 * optimistic-concurrency token repositories update on, and it is also what
 * `conditional` turns into an `If-Match` validator at the edge.
 *
 * See `notes/domain/identity.md`.
 */

import { conflict, invalid } from '../../../shared/errors/index.js';
import { type Email } from './email.js';
import { type UserId } from './ids.js';
import { hasPassword, type PasswordHash } from './password.js';
import { normalizeRoles, type Role } from './role.js';

/** What a repository writes and reads back. No behaviour, no privacy. */
export interface UserState {
  readonly id: UserId;
  readonly email: Email;
  /**
   * What a person is called. **Absent is legal and common.**
   *
   * Not an `Email`-style value object: there is nothing to validate beyond a
   * length, no normalisation that is correct across scripts, and a type that
   * only checks a length is a type that teaches nobody anything. §3.5 names it
   * in the registration payload.
   */
  readonly displayName?: string | undefined;
  /** Absent when the user has no password. Never an empty string in flight. */
  readonly passwordHash?: PasswordHash | undefined;
  readonly roles: readonly Role[];
  readonly enabled: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Whether a mutation changed anything, for the idempotent ones (§2.1). */
export interface Changed {
  readonly changed: boolean;
}

export class User {
  #email: Email;
  #displayName: string | undefined;
  #passwordHash: PasswordHash | undefined;
  #roles: readonly Role[];
  #enabled: boolean;
  #version: number;
  #updatedAt: Date;

  readonly id: UserId;
  readonly createdAt: Date;

  /**
   * The version this aggregate was **loaded at**.
   *
   * A repository updates on `(id, baseVersion)` and writes `version`. Keeping
   * both is what makes two mutations before one save correct: `version` has
   * moved twice, and the row to update is still the one nobody else has
   * touched. A single field would make `where version = version - 1` right only
   * for the single-mutation case, and wrong silently for every other.
   */
  readonly baseVersion: number;

  private constructor(state: UserState) {
    this.id = state.id;
    this.createdAt = state.createdAt;
    this.baseVersion = state.version;

    this.#email = state.email;
    this.#displayName = state.displayName;
    this.#passwordHash = state.passwordHash;
    this.#roles = normalizeRoles(state.roles);
    this.#enabled = state.enabled;
    this.#version = state.version;
    this.#updatedAt = state.updatedAt;
  }

  /**
   * A new user. **Active on creation** — conformance case 5.
   *
   * `at` and `id` are arguments: §7.9, the domain never calls the clock and
   * never mints an id.
   */
  static register(
    id: UserId,
    address: Email,
    hash: PasswordHash | undefined,
    at: Date,
    roles: readonly Role[] = [],
    displayName?: string,
  ): User {
    return new User({
      id,
      email: address,
      ...(displayName === undefined ? {} : { displayName }),
      ...(hash === undefined ? {} : { passwordHash: hash }),
      roles,
      enabled: true,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }

  /** Rehydrate from a row. The only other way to get one. */
  static from(state: UserState): User {
    return new User(state);
  }

  get email(): Email {
    return this.#email;
  }
  get displayName(): string | undefined {
    return this.#displayName;
  }
  get passwordHash(): PasswordHash | undefined {
    return this.#passwordHash;
  }
  get roles(): readonly Role[] {
    return this.#roles;
  }
  get enabled(): boolean {
    return this.#enabled;
  }
  get version(): number {
    return this.#version;
  }
  get updatedAt(): Date {
    return this.#updatedAt;
  }

  /** Has a password at all — §2.2. Not *has a correct one*. */
  get hasPassword(): boolean {
    return hasPassword(this.#passwordHash);
  }

  #touch(at: Date): void {
    this.#version += 1;
    this.#updatedAt = at;
  }

  /**
   * Set or clear the password.
   *
   * `undefined` clears it, which is a real operation rather than a hole: a user
   * who moves to SSO-only should stop having a password rather than keep an
   * unusable one nobody can reason about.
   */
  setPassword(hash: PasswordHash | undefined, at: Date): void {
    this.#passwordHash = hash;
    this.#touch(at);
  }

  /**
   * Rename. **Idempotent, like `disable` and `enable`** (§2.1) — it reports
   * whether it changed anything, which is what lets a `PATCH` publish an event
   * exactly once instead of on every no-op write.
   */
  rename(displayName: string | undefined, at: Date): Changed {
    const next = displayName?.trim() === '' ? undefined : displayName?.trim();
    if (this.#displayName === next) return { changed: false };
    this.#displayName = next;
    this.#touch(at);
    return { changed: true };
  }

  changeEmail(address: Email, at: Date): Changed {
    if (this.#email === address) return { changed: false };
    this.#email = address;
    this.#touch(at);
    return { changed: true };
  }

  /**
   * Idempotent, and it **reports whether it changed anything** — §2.1.
   *
   * The report is what lets a command publish `identity.user.disabled` exactly
   * once. Disabling an already-disabled user is a success with no event, not an
   * error and not a duplicate fact on the bus.
   */
  disable(at: Date): Changed {
    if (!this.#enabled) return { changed: false };
    this.#enabled = false;
    this.#touch(at);
    return { changed: true };
  }

  enable(at: Date): Changed {
    if (this.#enabled) return { changed: false };
    this.#enabled = true;
    this.#touch(at);
    return { changed: true };
  }

  grantRole(granted: Role, at: Date): Changed {
    if (this.#roles.includes(granted)) return { changed: false };
    this.#roles = normalizeRoles([...this.#roles, granted]);
    this.#touch(at);
    return { changed: true };
  }

  revokeRole(revoked: Role, at: Date): Changed {
    if (!this.#roles.includes(revoked)) return { changed: false };
    this.#roles = this.#roles.filter((held) => held !== revoked);
    this.#touch(at);
    return { changed: true };
  }

  /**
   * Refuse to authenticate a disabled user — conformance case 11.
   *
   * Stated as an invariant on the aggregate rather than a check in the login
   * command, so every future authentication method inherits it. That is the
   * convergence point earning its keep before a second method exists.
   */
  assertCanAuthenticate(): void {
    if (!this.#enabled) {
      throw invalid('this account is disabled');
    }
  }

  /** What a repository writes. */
  toState(): UserState {
    return {
      id: this.id,
      email: this.#email,
      ...(this.#passwordHash === undefined
        ? {}
        : { passwordHash: this.#passwordHash }),
      ...(this.#displayName === undefined
        ? {}
        : { displayName: this.#displayName }),
      roles: this.#roles,
      enabled: this.#enabled,
      version: this.#version,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
    };
  }
}

/**
 * The mismatch a repository reports when `(id, baseVersion)` matched no row.
 *
 * `Conflict` rather than `NotFound`: the row exists, and somebody else moved
 * it. A caller who sent `If-Match` gets `PreconditionFailed` from the edge
 * instead, which is the more precise answer — but only the edge knows a
 * validator was supplied.
 */
export function versionConflict(id: UserId): Error {
  return conflict(`user ${id} was modified by somebody else`);
}
