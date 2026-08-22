/**
 * Typed configuration. **L1 runtime.**
 *
 * Three ideas, from `../../../MODULES.md` and `../../../ARCHITECTURE.md` §8:
 *
 * 1. **Components declare their own schema.** Nothing here owns a list of every
 *    variable in the system; the composition root assembles what each part
 *    asked for.
 * 2. **All problems at once.** A misconfigured deploy reports everything wrong
 *    in one pass, not one variable per restart.
 * 3. **Secrets self-redact.** `sensitive()` returns a `Secret`, which prints as
 *    `[redacted]` through every path to text.
 *
 * **No dependency.** Every environment value is a string that needs coercion, a
 * default and sometimes a `Secret` — which is a small, specific job, and one
 * where the error messages matter more than the parsing. `CLAUDE.md` puts zod
 * at the HTTP boundary, where the input is JSON and the shapes are arbitrary;
 * this is a different boundary.
 *
 * Secret references (`file://`, `env://`) are resolved **before** parsing, by
 * wrapping the `Source` — `secrets` provides that, and nothing here changes.
 *
 * Note: `notes/patterns/env.md`.
 */

export { type Source, fromProcess, fromRecord, layered } from './source.js';

export {
  type Problem,
  type Reader,
  text,
  integer,
  flag,
  oneOf,
  url,
  duration,
  sensitive,
  optional,
} from './readers.js';

export { type Schema, type Config, load, explain, describe } from './load.js';
