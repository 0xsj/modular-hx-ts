/**
 * The mail port. **L2 substrate.**
 *
 * `send(message) -> Receipt`, and that is the whole surface.
 *
 * **`mailer` knows nothing about users, tokens or challenges.** It takes a
 * `Message`. The decision to send belongs to a context, and specifically to an
 * **event subscriber rather than a command's transaction** — a slow SMTP server
 * must not hold a transaction open, and a registration that rolls back must not
 * already have sent a welcome email.
 *
 * That is why there is no `send(userId, template)` convenience and no
 * transaction parameter anywhere in this module: the shape is deliberately
 * inconvenient to call mid-write, so the temptation never arises when
 * `identity` lands.
 *
 * See `notes/patterns/mailer.md`.
 */

import { type Message } from './message.js';

export interface Receipt {
  /** The message id the transport assigned, for correlating with a mail log. */
  readonly id: string;
  /** Which adapter handled it — `memory`, `smtp`, `none`. */
  readonly via: string;
  readonly acceptedAt: Date;
}

export interface Mailer {
  /**
   * Send, or fail with a `Kind` that says whether retrying could help.
   *
   * Validation failures are `Invalid` and will never succeed. An unreachable
   * server is `Unavailable`, which `isRetryable` reports true for — that
   * distinction is what lets `retry` and `breaker` do anything useful later,
   * and collapsing both into `Internal` would make every mail failure look
   * permanent.
   */
  send(message: Message): Promise<Receipt>;
}
