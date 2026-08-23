/**
 * Transactional mail. **L2 substrate.**
 *
 * `send(message) -> Receipt` behind a port, with three adapters and one
 * contract suite:
 *
 * ```
 * memory   records, and logs the link at debug
 * smtp     nodemailer against a real server (Mailpit at rung 2)
 * none     drops, and still validates
 * ```
 *
 * **The memory adapter is not a test double.** It is what lets `STORAGE=memory`
 * run `identity`'s verification flow with no Docker — the same role the memory
 * event bus plays for invariant `I1`. Somebody cloning this and running
 * `make dev` has to be able to finish a registration, which means the link has
 * to be retrievable.
 *
 * **`mailer` knows nothing about users, tokens or challenges.** It takes a
 * `Message`. The decision to send belongs to a context, and to an **event
 * subscriber rather than a command's transaction** — a slow SMTP server must
 * not hold a transaction open, and a rolled-back registration must not already
 * have sent a welcome email.
 *
 * Note: `notes/patterns/mailer.md`.
 */

export {
  type Address,
  type Message,
  formatAddress,
  message,
} from './message.js';

export { type Mailer, type Receipt } from './port.js';

export {
  type MemoryMailer,
  type MemoryOptions,
  type Reporter,
  type Sent,
  memoryMailer,
  noopMailer,
} from './memory.js';

export { type SmtpOptions, smtpMailer } from './smtp.js';

export {
  type Part,
  type Rendered,
  type Sources,
  type Templates,
  type Vars,
  PARTS,
  compileTemplates,
} from './templates.js';
