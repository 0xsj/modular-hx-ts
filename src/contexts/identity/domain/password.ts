/**
 * `Password` and `PasswordHash`. **`identity` domain.**
 *
 * Two types that are deliberately not one:
 *
 * - **`Password` is a value in flight.** It exists between the request body and
 *   the hashing port and nowhere else. It never reaches a repository.
 * - **`PasswordHash` is the stored form, and it is opaque.** The domain cannot
 *   produce one and cannot verify one — that is an app-layer port, so the
 *   algorithm is a wiring decision and argon2 versus scrypt never reaches here.
 *
 * See `notes/domain/identity.md`.
 */

import { invalid } from '../../../shared/errors/index.js';
import { type Email } from './email.js';

/** §2.1. Long enough to matter; the ceiling is a cost control, not a strength one. */
const MIN_LENGTH = 8;
const MAX_LENGTH = 128;

const REDACTED = '[redacted]';

/**
 * A password on its way to the hasher.
 *
 * **A class rather than a branded string, and that is forced by §2.1's
 * *redacts in every string form*.** A branded primitive prints itself: any
 * template literal, any `JSON.stringify` of a request object, any `console.log`
 * of a struct that happens to contain it puts the plaintext somewhere it
 * outlives the request. There is no way to intercept that on a `string`.
 *
 * With an object there are exactly three ways out and all three are covered —
 * `toString`, `toJSON`, and Node's inspect hook, which is what a bare
 * `console.log(value)` actually calls. `reveal()` is the fourth, and it is
 * named so that reading the secret is a visible act at the call site.
 */
export class Password {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
  }

  /**
   * Parse, or throw.
   *
   * **No composition rules**, and that is specified rather than lazy — §2.1.
   * Requiring a digit and a symbol measurably *reduces* entropy by pushing
   * everyone onto the same handful of patterns, and NIST SP 800-63B has
   * recommended against it since 2017. A floor and a ceiling are the whole
   * policy.
   *
   * **Never equal to the email**, which is the one composition rule worth
   * keeping: it is the first guess an attacker who knows the address makes.
   */
  static of(raw: string, address?: Email): Password {
    if (raw.length < MIN_LENGTH) {
      throw invalid('a password is at least 8 characters', [
        { field: 'password', message: 'is too short' },
      ]);
    }
    if (raw.length > MAX_LENGTH) {
      // A memory-hard hash over a megabyte of input is a free way to spend a
      // core, so the ceiling is a denial-of-service control.
      throw invalid('a password is at most 128 characters', [
        { field: 'password', message: 'is too long' },
      ]);
    }
    if (address !== undefined && raw.toLowerCase() === address) {
      throw invalid('a password may not be the email address', [
        { field: 'password', message: 'may not be the email address' },
      ]);
    }

    return new Password(raw);
  }

  /** The plaintext. Called by the hashing port, and by nothing else. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /**
   * Node's `util.inspect` hook.
   *
   * Without it, `console.log({ password })` prints the private field's contents
   * — private to TypeScript is not private to the inspector.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

declare const tag: unique symbol;

/**
 * The stored form. Opaque to the domain.
 *
 * A branded string rather than a class, because unlike a `Password` this one
 * has to round-trip through a database column unchanged. Keeping it out of logs
 * is `classification`'s job and `redact`'s, which is where field-level
 * sensitivity already lives.
 */
export type PasswordHash = string & { readonly [tag]: 'PasswordHash' };

/**
 * Narrow a stored hash. The app layer's hashing port produces these.
 *
 * **Empty means no password** — §2.2's first bullet, and the reason
 * `PasswordHash` is optional on `User`. A user who arrived through SSO has
 * none, and a design where every user *has* a password must invent one for
 * them: a random unusable string, a sentinel, a nullable column read as empty.
 * Each is a lie somebody eventually compares against.
 */
export function passwordHash(value: string): PasswordHash {
  return value as PasswordHash;
}

/** Does this user have a password at all? */
export function hasPassword(hash: PasswordHash | undefined): boolean {
  return hash !== undefined && hash.length > 0;
}
