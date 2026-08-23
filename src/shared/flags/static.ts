/**
 * Flags as code. **The `static` provider.**
 *
 * The table in the composition root, changed by deploy. It is the right answer
 * more often than it looks: a flag that only ever flips with a release does not
 * need a database, and this one cannot be stale, cannot fail, and is reviewable
 * in the same diff as the code it guards.
 *
 * See `notes/patterns/flags.md`.
 */

import { unwrap } from '../result/index.js';
import { validate, type Flag } from './rule.js';
import { type Source } from './port.js';

export function staticSource(flags: readonly Flag[]): Source {
  // Validated here, so a typo is a startup failure rather than a flag that
  // silently never matches.
  const byKey = new Map(unwrap(validate(flags)).map((f) => [f.key, f]));

  return {
    get: (key) => byKey.get(key),
    all: () => [...byKey.values()],
  };
}
