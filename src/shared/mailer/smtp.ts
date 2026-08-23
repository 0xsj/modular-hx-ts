/**
 * The SMTP adapter. **The real one.**
 *
 * `nodemailer` is confined here by rule `S10` — the vendor table in
 * `layers.cjs` names this module as its owner, and a fixture trips on an import
 * from anywhere else. SMTP is a protocol with a specification, which is the bar
 * ADR 0005 sets for taking a dependency at all.
 *
 * See `notes/patterns/mailer.md`.
 */

import nodemailer from 'nodemailer';
import { type Clock } from '../clock/index.js';
import { AppError, Kind } from '../errors/index.js';
import { type Secret } from '../redact/index.js';
import { formatAddress, message as validate, type Message } from './message.js';
import { type Mailer, type Receipt } from './port.js';

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly clock: Clock;
  readonly username?: string;
  /**
   * Held as a `Secret`, so it cannot reach a log through any of the four
   * stringification paths — including the one `console.log` uses.
   */
  readonly password?: Secret<string>;
  /** STARTTLS or implicit TLS. Off for Mailpit, on everywhere real. */
  readonly secure?: boolean;
  readonly timeout?: number;
}

/**
 * SMTP status codes that mean *try again*, versus *this will never work*.
 *
 * A 4xx is a transient rejection by the server and a 5xx is a permanent one.
 * Anything with no code at all — DNS failure, refused connection, timeout — is
 * the server being unreachable, which is the most retryable case of the three.
 */
function kindFor(error: unknown): Kind {
  const code = (error as { responseCode?: unknown }).responseCode;

  if (typeof code === 'number') {
    if (code >= 400 && code < 500) return Kind.Unavailable;
    // A permanent rejection: a bad recipient, a refused relay. Retrying is
    // waste, and `Invalid` tells the caller it owns the problem.
    if (code >= 500) return Kind.Invalid;
  }

  const errno = (error as { code?: unknown }).code;
  if (errno === 'ETIMEDOUT' || errno === 'ESOCKETTIMEDOUT') return Kind.Timeout;

  // ECONNREFUSED, ENOTFOUND, EAI_AGAIN, or anything unrecognised while talking
  // to a remote host. Unavailable rather than Internal, and that distinction is
  // the whole point: `isRetryable` is true here and false for Internal, so this
  // is what lets `retry` and `breaker` do anything useful.
  return Kind.Unavailable;
}

export function smtpMailer(options: SmtpOptions): Mailer {
  const { clock } = options;

  const transport = nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure ?? false,
    connectionTimeout: options.timeout ?? 10_000,
    greetingTimeout: options.timeout ?? 10_000,
    socketTimeout: options.timeout ?? 10_000,
    ...(options.username === undefined
      ? {}
      : {
          auth: {
            user: options.username,
            // Exposed exactly here, at the one call that needs the bytes, and
            // never held in a variable that outlives it.
            pass: options.password?.expose() ?? '',
          },
        }),
  });

  return {
    async send(candidate: Message): Promise<Receipt> {
      const checked = validate(candidate);
      if (!checked.ok) throw checked.error;
      const m = checked.value;

      try {
        const info = await transport.sendMail({
          from: formatAddress(m.from),
          to: m.to.map(formatAddress),
          ...(m.cc === undefined ? {} : { cc: m.cc.map(formatAddress) }),
          ...(m.replyTo === undefined
            ? {}
            : { replyTo: formatAddress(m.replyTo) }),
          subject: m.subject,
          text: m.text,
          html: m.html,
        });

        return {
          id: info.messageId,
          via: 'smtp',
          acceptedAt: clock.now(),
        };
      } catch (error) {
        const status = (error as { responseCode?: unknown }).responseCode;

        // **Names the host and the status, never the credential.** A send
        // failure is exactly the moment somebody pastes a log into a ticket.
        throw new AppError(
          kindFor(error),
          `smtp ${options.host}:${String(options.port)} refused the message` +
            (typeof status === 'number' ? ` (${String(status)})` : ''),
          {
            cause: error,
            details: {
              host: options.host,
              port: options.port,
              ...(typeof status === 'number' ? { status } : {}),
            },
          },
        );
      }
    },
  };
}
