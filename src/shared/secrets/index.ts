/**
 * Secret references. **L1 runtime.**
 *
 * `../../../ARCHITECTURE.md` §8: any variable may hold a reference instead of a
 * literal, resolved **before** configuration is parsed. Two schemes:
 *
 * ```
 * SMTP_PASSWORD=file:///run/secrets/smtp#password
 * SMTP_PASSWORD=env://SMTP_PASSWORD_REAL
 * ```
 *
 * It works by wrapping an `env` `Source`, which is why that port exists at all
 * — `env` never learns anything happened, and no schema changes.
 *
 * `../../../INFRASTRUCTURE.md` §7.1 is the payoff: a Kubernetes `Secret` mounted
 * as files is `file:///run/secrets/smtp#password` and needs **no new code**.
 *
 * Note: `notes/patterns/secrets.md`.
 */

export { type Reference, type Scheme, parse, describe } from './reference.js';

export {
  type FileSystem,
  MAX_BYTES,
  nodeFileSystem,
  fakeFileSystem,
} from './filesystem.js';

export { type Resolved, resolving } from './resolve.js';
