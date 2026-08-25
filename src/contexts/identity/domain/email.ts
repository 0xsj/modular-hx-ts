/**
 * `Email`. **`identity` domain — a value object that normalizes at
 * construction.**
 *
 * §7.2: *value objects normalize and validate at construction, never at use.*
 * Everything downstream — the unique index, the lookup on login, the comparison
 * in `Password` — can then assume one canonical form, because there is no way
 * to hold an `Email` that never went through here.
 *
 * See `notes/domain/identity.md`.
 */

import { invalid } from '../../../shared/errors/index.js';

declare const tag: unique symbol;
export type Email = string & { readonly [tag]: 'Email' };

/**
 * A deliberately loose shape check.
 *
 * `local@domain.tld`, one `@`, no whitespace, a dot in the domain. **Not RFC
 * 5322** — that grammar admits addresses no provider will accept and rejecting
 * on it is how a validator becomes the reason somebody cannot sign up. The only
 * real proof an address exists is that mail to it arrives, which is what the
 * verification challenge is for.
 */
const SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** RFC 5321 §4.5.3.1.3 — the maximum reverse-path a server must accept. */
const MAX_LENGTH = 254;

/**
 * Parse and normalize, or throw.
 *
 * **Lowercases the whole address, not just the domain** — §2.1, and it is a
 * decision rather than an oversight. The local part is case-sensitive per RFC
 * 5321, so `Bob@x.com` and `bob@x.com` are formally two mailboxes; in practice
 * no provider treats them as two, and preserving the distinction means
 * `Bob@x.com` can register while `bob@x.com` is already taken. That is a
 * support ticket that reads as a bug, and an account-takeover vector wherever a
 * downstream system disagrees with us about the comparison.
 *
 * **Throws rather than returning a `Result`**, because `S7` permits `domain/`
 * exactly one import and `result` is not it. Boundary validation is zod's job
 * in `transport/`, which is where a caller gets every field problem at once;
 * this is the second line, and reaching it means the boundary let something
 * through.
 */
export function email(raw: string): Email {
  const normalized = raw.trim().toLowerCase();

  if (normalized.length === 0) {
    throw invalid('an email address is required', [
      { field: 'email', message: 'is required' },
    ]);
  }
  if (normalized.length > MAX_LENGTH) {
    throw invalid('an email address is at most 254 characters', [
      { field: 'email', message: 'is too long' },
    ]);
  }
  if (!SHAPE.test(normalized)) {
    throw invalid('not an email address', [
      { field: 'email', message: 'is not an email address' },
    ]);
  }

  return normalized as Email;
}

/**
 * The same, without throwing — for a caller that has a fallback.
 *
 * `login` uses it: an unparseable address is not a reason to answer differently
 * from a wrong password (case 7), so it needs *no address* rather than an
 * error.
 */
export function emailOrUndefined(raw: string): Email | undefined {
  try {
    return email(raw);
  } catch {
    return undefined;
  }
}
