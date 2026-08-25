/**
 * The `Challenge` aggregate. **`identity` domain.**
 *
 * **One aggregate, many purposes** — §2.2. Verify email, reset password, change
 * email, magic link. Four aggregates would have four copies of the same
 * issue-and-consume rules, and the copy that drifted would be the one that
 * forgot single-use.
 *
 * §7.5 states the test: *one aggregate with a purpose discriminant beats four
 * similar ones **when the issue-and-consume rules are the same**.* They are —
 * mint a secret, tag it, expire it, consume it once. What differs is what
 * happens **after** consumption, and that is a handler rather than an
 * aggregate.
 *
 * Four properties, and each is load-bearing:
 *
 * - **Single-use.** `consumedAt` is set once; a second consume fails.
 * - **TTL'd.** An emailed secret that never expires is a permanent credential
 *   sitting in a mailbox.
 * - **Purpose-discriminated**, and the purpose is *inside the MAC*. A reset
 *   secret cannot be replayed as a magic link.
 * - **Idempotent by source event id** — §7.7. At-least-once delivery means a
 *   subscriber sees duplicates, and a unique column makes that safe **in the
 *   domain** rather than in middleware.
 *
 * See `notes/domain/identity.md`.
 */

import { invalid } from '../../../shared/errors/index.js';
import { type ChallengeId, type UserId } from './ids.js';

/**
 * What a challenge is for.
 *
 * Closed, because the purpose is inside the MAC tag: adding one is a real
 * decision and forgetting to handle it is a compile error at the consume site.
 */
export const Purpose = {
  VerifyEmail: 'verify_email',
  ResetPassword: 'reset_password',
  ChangeEmail: 'change_email',
  MagicLink: 'magic_link',
} as const;

export type Purpose = (typeof Purpose)[keyof typeof Purpose];

const PURPOSES: readonly string[] = Object.values(Purpose);

export function isPurpose(value: string): value is Purpose {
  return PURPOSES.includes(value);
}

export interface ChallengeState {
  readonly id: ChallengeId;
  readonly userId: UserId;
  readonly purpose: Purpose;
  /** `sha256:` of the emailed secret. Never the secret. */
  readonly secretFingerprint: string;
  /** `v1.<kid>.<tag>` binding id, user and purpose together. */
  readonly tag: string;
  /**
   * What the challenge will do when consumed — a new address, for
   * `change_email`. Empty for the purposes that need nothing.
   *
   * **On the challenge rather than on the request that consumes it**, because
   * the address was verified when the link was *issued*: taking it from the
   * consuming request would let anyone holding the link redirect it.
   */
  readonly payload: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt?: Date | undefined;
  /** §7.7. Unique, so an at-least-once redelivery cannot issue twice. */
  readonly sourceEventId?: string | undefined;
  readonly version: number;
}

export class Challenge {
  #consumedAt: Date | undefined;
  #version: number;

  readonly id: ChallengeId;
  readonly userId: UserId;
  readonly purpose: Purpose;
  readonly secretFingerprint: string;
  readonly tag: string;
  readonly payload: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly sourceEventId: string | undefined;
  readonly baseVersion: number;

  private constructor(state: ChallengeState) {
    this.id = state.id;
    this.userId = state.userId;
    this.purpose = state.purpose;
    this.secretFingerprint = state.secretFingerprint;
    this.tag = state.tag;
    this.payload = state.payload;
    this.issuedAt = state.issuedAt;
    this.expiresAt = state.expiresAt;
    this.sourceEventId = state.sourceEventId;
    this.baseVersion = state.version;

    this.#consumedAt = state.consumedAt;
    this.#version = state.version;
  }

  static issue(
    id: ChallengeId,
    userId: UserId,
    purpose: Purpose,
    secretFingerprint: string,
    tag: string,
    at: Date,
    expiresAt: Date,
    payload = '',
    sourceEventId?: string,
  ): Challenge {
    return new Challenge({
      id,
      userId,
      purpose,
      secretFingerprint,
      tag,
      payload,
      issuedAt: at,
      expiresAt,
      ...(sourceEventId === undefined ? {} : { sourceEventId }),
      version: 1,
    });
  }

  static from(state: ChallengeState): Challenge {
    return new Challenge(state);
  }

  get consumedAt(): Date | undefined {
    return this.#consumedAt;
  }
  get version(): number {
    return this.#version;
  }

  isUsableAt(now: Date): boolean {
    if (this.#consumedAt !== undefined) return false;
    return now.getTime() < this.expiresAt.getTime();
  }

  /**
   * Spend it, once.
   *
   * **Returns nothing about *why* it failed**, and that is conformance case 13
   * expressed in a signature: expired, already consumed, wrong purpose and
   * never existed must be one indistinguishable error. Four distinct errors is
   * a probe — an attacker holding a stale link learns whether the address
   * exists, whether somebody else already used it, and whether they guessed a
   * real id.
   */
  consume(at: Date, forPurpose: Purpose): void {
    if (this.purpose !== forPurpose || !this.isUsableAt(at)) {
      throw challengeRefused();
    }
    this.#consumedAt = at;
    this.#version += 1;
  }

  toState(): ChallengeState {
    return {
      id: this.id,
      userId: this.userId,
      purpose: this.purpose,
      secretFingerprint: this.secretFingerprint,
      tag: this.tag,
      payload: this.payload,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      ...(this.#consumedAt === undefined
        ? {}
        : { consumedAt: this.#consumedAt }),
      ...(this.sourceEventId === undefined
        ? {}
        : { sourceEventId: this.sourceEventId }),
      version: this.#version,
    };
  }
}

/**
 * **The one refusal, for every reason** — conformance case 13.
 *
 * Built here so no call site can spell it differently, and so adding a new
 * failure mode later has nothing to spell at all. `Invalid` rather than
 * `NotFound`: a 404 for *never existed* and a 400 for *already used* is the
 * same oracle wearing two status codes.
 */
export function challengeRefused(): Error {
  return invalid('this link is not valid');
}

/**
 * What the MAC is computed over.
 *
 * **Id, user and purpose, joined unambiguously.** Binding the purpose is the
 * point: without it a `reset_password` secret and a `magic_link` secret are
 * interchangeable, and the weaker flow becomes the way into the stronger one.
 * Binding the user stops a challenge being moved between accounts.
 *
 * The separator is U+001F for the reason it is everywhere else in this
 * repository — it cannot occur in any of the three parts, so the join needs no
 * rejection rule.
 */
export function challengeMessage(
  id: ChallengeId,
  userId: UserId,
  purpose: Purpose,
): string {
  return [id, userId, purpose].join(SEPARATOR);
}

/**
 * ASCII unit separator, U+001F. **An escape, never a literal byte.**
 *
 * A raw control character makes the file binary to every text tool: `grep`
 * skips it, an editor eats it, and the only thing that catches it is
 * `tests/rules/encoding.test.ts`. This repository has now written one by
 * accident five times, twice in this session.
 */
const SEPARATOR = '\u001f';
