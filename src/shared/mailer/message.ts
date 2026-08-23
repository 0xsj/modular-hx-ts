/**
 * A message, and the validation that keeps it one message. **L2 substrate.**
 *
 * **This is the security-relevant part of the module.** SMTP headers are
 * separated by CRLF, so a display name or a subject containing a carriage
 * return or a line feed does not produce a malformed header — it produces an
 * **extra one**. A display name of `Ada<CR><LF>Bcc: attacker@example.com` sends
 * a silent copy; a subject with a line feed can forge a `From`. Every
 * header-bound field is therefore rejected on control characters, not escaped
 * and not stripped.
 *
 * Rejecting rather than sanitising is deliberate. A stripped newline turns an
 * attack into a slightly odd display name that nobody investigates; a rejection
 * is a `Kind.Invalid` with a field name, at the boundary, where the caller can
 * see what it did.
 *
 * See `notes/patterns/mailer.md`.
 */

import { invalid, type FieldIssue } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

export interface Address {
  readonly email: string;
  /** Optional display name. Header-bound, so it is validated like the rest. */
  readonly name?: string;
}

export interface Message {
  readonly to: readonly Address[];
  readonly from: Address;
  readonly replyTo?: Address;
  readonly cc?: readonly Address[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * Correlates this send with the request that caused it, in logs and in the
   * memory adapter's record. Header-bound.
   */
  readonly tag?: string;
}

/**
 * Anything that can start a new header line, plus the rest of C0 and DEL.
 *
 * CR and LF are the injection; NUL truncates in some agents. The whole range is
 * refused because none of it is meaningful in a header and enumerating the
 * harmless ones is a list somebody has to keep correct.
 *
 * Written as escapes rather than literal bytes on purpose — a raw control
 * character in a source file makes the file binary to every text tool, which
 * cost this repository four rounds of a fixture appearing not to exist.
 */
/* eslint-disable-next-line no-control-regex --
   Matching control characters is the entire purpose of this rule. The lint
   exists to catch a control character written into a pattern by accident;
   here the pattern is the security check, and disabling it locally is
   cheaper than a check nobody writes because the linter objected. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Deliberately permissive: a real address grammar is RFC 5321, and rejecting a
 * valid-but-unusual address is its own bug. What matters here is that it is one
 * address, on one line, with no room for a second header.
 */
const EMAIL = /^[^\s@<>,;:]+@[^\s@<>,;:]+\.[^\s@<>,;:]+$/;

function checkHeaderField(
  field: string,
  value: string | undefined,
  issues: FieldIssue[],
): void {
  if (value === undefined) return;
  if (CONTROL.test(value)) {
    // The message names the class of problem and never echoes the value — a
    // rejected header ends up in a log, and echoing it back would reproduce the
    // injection there.
    issues.push({
      field,
      message: 'contains a control character, which would inject a header',
    });
  }
}

function checkAddress(
  field: string,
  address: Address,
  issues: FieldIssue[],
): void {
  checkHeaderField(`${field}.email`, address.email, issues);
  checkHeaderField(`${field}.name`, address.name, issues);

  if (!EMAIL.test(address.email)) {
    issues.push({
      field: `${field}.email`,
      message: 'is not an email address',
    });
  }
}

/**
 * A message, or every reason it is not one.
 *
 * All problems at once, like `env` — a caller fixing one field per round trip is
 * the same waste there as here.
 */
export function message(candidate: Message): Result<Message> {
  const issues: FieldIssue[] = [];

  if (candidate.to.length === 0) {
    issues.push({ field: 'to', message: 'is required' });
  }
  candidate.to.forEach((address, index) => {
    checkAddress(`to.${String(index)}`, address, issues);
  });
  (candidate.cc ?? []).forEach((address, index) => {
    checkAddress(`cc.${String(index)}`, address, issues);
  });

  checkAddress('from', candidate.from, issues);
  if (candidate.replyTo !== undefined) {
    checkAddress('replyTo', candidate.replyTo, issues);
  }

  checkHeaderField('subject', candidate.subject, issues);
  checkHeaderField('tag', candidate.tag, issues);

  if (candidate.subject.trim() === '') {
    issues.push({ field: 'subject', message: 'is required' });
  }
  // Both parts, always: a text-only message looks broken in a modern client,
  // and an HTML-only one is unreadable in a plain-text one and scores as spam.
  if (candidate.text.trim() === '') {
    issues.push({ field: 'text', message: 'is required' });
  }
  if (candidate.html.trim() === '') {
    issues.push({ field: 'html', message: 'is required' });
  }

  return issues.length === 0
    ? ok(candidate)
    : err(invalid('the message cannot be sent as written', issues));
}

/** `Ada Lovelace <ada@example.com>` — only ever built from validated parts. */
export function formatAddress(address: Address): string {
  return address.name === undefined || address.name === ''
    ? address.email
    : `${address.name} <${address.email}>`;
}
