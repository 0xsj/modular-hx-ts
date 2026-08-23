/**
 * Feature flags. **L3 capability, and the last of the layer.**
 *
 * **Config is read once at boot and changing it needs a restart. A flag is read
 * per request and changes without one.** That difference is the entire
 * justification for the module — if a value never needs to change while the
 * process runs, it belongs in `env` and not here.
 *
 * ```
 * static     the table in the composition root, changed by deploy
 * file       polled JSON, changed without a deploy
 * postgres   fleet-wide, TTL-cached, serves stale and refreshes behind
 * ```
 *
 * **An unknown key is off, and reported as unknown** rather than as a
 * considered `false` — a typo must disable a feature, never enable one, and a
 * misspelling must be visible rather than looking like somebody's decision.
 *
 * **Rules, not a DSL.** Selectors ANDed, first match wins. If a rule needs
 * boolean logic beyond AND, that is two rules.
 *
 * **Cohorts are cross-language.** A 10% rollout must mean the same 10% in every
 * blueprint; `cohort.ts` states the bucketing function exactly, which
 * `../../../conformance/fixtures/README.md` §4 records as blocked on this
 * module.
 *
 * Note: `notes/patterns/flags.md`.
 */

export {
  type Decision,
  type Flag,
  type Rule,
  type Scope,
  type Selector,
  Status,
  evaluate,
  isFlagKey,
  validate,
} from './rule.js';

export { BUCKETS, SEPARATOR, bucketOf, inCohort } from './cohort.js';

export {
  type Flags,
  type FlagsOptions,
  type Source,
  makeFlags,
} from './port.js';

export { staticSource } from './static.js';

export {
  type FileOptions,
  type FileSource,
  type ReadFile,
  fileSource,
} from './file.js';

export {
  type PostgresOptions,
  type PostgresSource,
  FLAGS_TABLE,
  flagMigrations,
  postgresSource,
} from './postgres.js';
