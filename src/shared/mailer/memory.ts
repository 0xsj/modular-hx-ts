/**
 * The in-process mailbox. **A real adapter, not a test double.**
 *
 * The distinction matters and is the same one the memory event bus carries:
 * this is what lets `STORAGE=memory` run `identity`'s verification flow **with
 * no Docker**. Somebody cloning the repository, running `make dev` and
 * registering a user has to be able to complete the flow, and that means the
 * verification link has to be *retrievable* — so it is logged at debug and kept
 * in a mailbox anything can read.
 *
 * Invariant `I1` again: the whole application, zero external dependencies.
 *
 * See `notes/patterns/mailer.md`.
 */

import { type Clock } from '../clock/index.js';
import { type IdGenerator } from '../id/index.js';
import { message as validate, type Message } from './message.js';
import { type Mailer, type Receipt } from './port.js';

/** Three methods, declared here rather than importing `logger` — as `lifecycle` does. */
export interface Reporter {
  debug(message: string, fields?: Record<string, unknown>): void;
}

export interface Sent {
  readonly receipt: Receipt;
  readonly message: Message;
}

export interface MemoryMailer extends Mailer {
  /** Everything sent, in order. */
  outbox(): readonly Sent[];
  /** The most recent message to an address — what a dev-flow test wants. */
  lastTo(email: string): Sent | undefined;
  clear(): void;
}

export interface MemoryOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly reporter?: Reporter;
}

/**
 * The first URL in the text part.
 *
 * Extracted so the log line carries the thing a developer actually needs. A
 * verification email whose link is buried in a rendered body is a link nobody
 * can use from a terminal.
 */
function firstLink(text: string): string | undefined {
  return /https?:\/\/\S+/.exec(text)?.[0];
}

export function memoryMailer(options: MemoryOptions): MemoryMailer {
  const { clock, ids } = options;
  const sent: Sent[] = [];

  return {
    send(candidate: Message): Promise<Receipt> {
      // Validated here too, not only in the SMTP adapter. An injection that the
      // memory adapter accepted would be a rule the contract suite could not
      // assert of every adapter, and a header check that only runs in
      // production is a header check nobody has tested.
      // **Rejected, not thrown.** `send` is not `async` here, so a bare `throw`
      // would propagate *synchronously* while the SMTP adapter — which is
      // `async` — rejects. A caller writing `send(m).catch(...)` would then
      // work against one adapter and blow up against another, which is exactly
      // the divergence one contract suite over three adapters exists to stop.
      const checked = validate(candidate);
      if (!checked.ok) return Promise.reject(checked.error);

      const receipt: Receipt = {
        id: ids.uuid(),
        via: 'memory',
        acceptedAt: clock.now(),
      };
      sent.push({ receipt, message: checked.value });

      // Debug, not info: this is a developer convenience on a path that runs on
      // every send, and a link in a production log at info would be a token in
      // a log aggregator.
      options.reporter?.debug('mail sent', {
        id: receipt.id,
        to: checked.value.to.map((a) => a.email).join(', '),
        subject: checked.value.subject,
        link: firstLink(checked.value.text),
      });

      return Promise.resolve(receipt);
    },

    outbox: () => sent,

    lastTo(email) {
      for (let i = sent.length - 1; i >= 0; i--) {
        const one = sent[i];
        if (one?.message.to.some((a) => a.email === email) === true) return one;
      }
      return undefined;
    },

    clear() {
      sent.length = 0;
    },
  };
}

/**
 * The adapter that drops everything. `MAIL_PROVIDER=none`.
 *
 * For an environment that must not send — a restored production snapshot, a
 * load test, a preview deploy. It still **validates**, so a header injection
 * fails identically wherever it is configured; an adapter that skipped
 * validation because it was going to discard the message anyway would let a bug
 * through in staging that only appears in production.
 */
export function noopMailer(clock: Clock, ids: IdGenerator): Mailer {
  return {
    send(candidate: Message): Promise<Receipt> {
      const checked = validate(candidate);
      if (!checked.ok) return Promise.reject(checked.error);

      return Promise.resolve({
        id: ids.uuid(),
        via: 'none',
        acceptedAt: clock.now(),
      });
    },
  };
}
