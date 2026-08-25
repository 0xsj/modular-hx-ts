/**
 * The `ApiKey` aggregate. **`identity` domain.**
 *
 * A non-human credential belonging to a human. Two rules make it safe, and both
 * are conformance cases:
 *
 * - **Shown once, never returned again** (case 16). Only a fingerprint is
 *   stored, so it is not that we *choose* not to return it — there is nothing
 *   to return.
 * - **Scopes only ever subtract** (case 17). The effective permission is the
 *   intersection of a key's scopes and its owner's grants, so a leaked key can
 *   never exceed the person it belongs to. `authz` enforces the intersection;
 *   this aggregate carries the scopes.
 *
 * See `notes/domain/identity.md`.
 */

import { invalid } from '../../../shared/errors/index.js';
import { type ApiKeyId, type UserId } from './ids.js';

/**
 * The prefix every key carries.
 *
 * **So a leaked key is findable.** Secret scanners — GitHub's, and every
 * commit hook that copies it — match on a known prefix, and a key that looks
 * like any other base64 string is one nobody can scan for. It also makes the
 * bearer scheme unambiguous: one `Authorization` header, two credential kinds,
 * told apart without a second header to get wrong.
 */
export const API_KEY_PREFIX = 'ak_';

export function looksLikeApiKey(presented: string): boolean {
  return presented.startsWith(API_KEY_PREFIX);
}

export interface ApiKeyState {
  readonly id: ApiKeyId;
  readonly userId: UserId;
  /** What a human calls it in a list. Not a secret, not unique. */
  readonly name: string;
  /** `sha256:` of the key. Never the key. */
  readonly fingerprint: string;
  /**
   * `resource:verb` actions this key may perform.
   *
   * **Empty means no scopes, which means the key can do nothing** — not
   * *everything*. An empty list read as unrestricted is the single most
   * expensive way to get case 17 wrong, so it is stated here and asserted.
   */
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt?: Date | undefined;
  readonly expiresAt?: Date | undefined;
  readonly revokedAt?: Date | undefined;
  readonly version: number;
}

const TOUCH_INTERVAL_MS = 60_000;

export class ApiKey {
  #lastUsedAt: Date | undefined;
  #revokedAt: Date | undefined;
  #version: number;

  readonly id: ApiKeyId;
  readonly userId: UserId;
  readonly name: string;
  readonly fingerprint: string;
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly expiresAt: Date | undefined;
  readonly baseVersion: number;

  private constructor(state: ApiKeyState) {
    this.id = state.id;
    this.userId = state.userId;
    this.name = state.name;
    this.fingerprint = state.fingerprint;
    this.scopes = [...new Set(state.scopes)].sort();
    this.createdAt = state.createdAt;
    this.expiresAt = state.expiresAt;
    this.baseVersion = state.version;

    this.#lastUsedAt = state.lastUsedAt;
    this.#revokedAt = state.revokedAt;
    this.#version = state.version;
  }

  static issue(
    id: ApiKeyId,
    userId: UserId,
    name: string,
    fingerprint: string,
    scopes: readonly string[],
    at: Date,
    expiresAt?: Date,
  ): ApiKey {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > 64) {
      throw invalid('an API key needs a name of 1-64 characters', [
        { field: 'name', message: 'is required' },
      ]);
    }

    return new ApiKey({
      id,
      userId,
      name: trimmed,
      fingerprint,
      scopes,
      createdAt: at,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      version: 1,
    });
  }

  static from(state: ApiKeyState): ApiKey {
    return new ApiKey(state);
  }

  get lastUsedAt(): Date | undefined {
    return this.#lastUsedAt;
  }
  get revokedAt(): Date | undefined {
    return this.#revokedAt;
  }
  get version(): number {
    return this.#version;
  }

  /** Revoked beats expired, for the reason it does on a session. */
  isValidAt(now: Date): boolean {
    if (this.#revokedAt !== undefined) return false;
    if (this.expiresAt === undefined) return true;
    return now.getTime() < this.expiresAt.getTime();
  }

  revoke(at: Date): { readonly changed: boolean } {
    if (this.#revokedAt !== undefined) return { changed: false };
    this.#revokedAt = at;
    this.#version += 1;
    return { changed: true };
  }

  /** Throttled, like a session's — this is telemetry, not a security decision. */
  touch(now: Date): { readonly changed: boolean } {
    const last = this.#lastUsedAt;
    if (
      last !== undefined &&
      now.getTime() - last.getTime() < TOUCH_INTERVAL_MS
    ) {
      return { changed: false };
    }
    this.#lastUsedAt = now;
    this.#version += 1;
    return { changed: true };
  }

  toState(): ApiKeyState {
    return {
      id: this.id,
      userId: this.userId,
      name: this.name,
      fingerprint: this.fingerprint,
      scopes: this.scopes,
      createdAt: this.createdAt,
      ...(this.#lastUsedAt === undefined
        ? {}
        : { lastUsedAt: this.#lastUsedAt }),
      ...(this.expiresAt === undefined ? {} : { expiresAt: this.expiresAt }),
      ...(this.#revokedAt === undefined ? {} : { revokedAt: this.#revokedAt }),
      version: this.#version,
    };
  }
}
