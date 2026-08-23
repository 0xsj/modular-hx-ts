/**
 * The sensitivity vocabulary. **L3 capability, and the first of the layer.**
 *
 * A closed set of levels and a way to attach one to a field. **Nothing more.**
 * It makes no decisions, performs no I/O, and enforces nothing on its own.
 *
 * ```
 * public · internal · pii · secret · regulated
 * ```
 *
 * **Why it goes first.** `redact`, `fieldcrypt`, `readaudit`, `retention`,
 * `exports` and `cost` all read it. Built after them, there would be six
 * independent opinions about whether an email address is PII — and the specific
 * failure is the export path disagreeing with the log path, which is how data
 * leaves the building looking compliant. Retrofitting means reconciling
 * opinions that have already diverged rather than declaring one.
 *
 * **What it must not do.** No encryption, no masking, no policy. It says a
 * field is PII; it does not say what happens to PII. `fieldcrypt` decides
 * encryption, `redact` decides printing, `retention` decides deletion,
 * `exports` decides visibility. A classification module that starts making
 * those decisions has become five modules wearing one name.
 *
 * Note: `notes/patterns/classification.md`.
 */

export {
  Level,
  LEVELS,
  UNCLASSIFIED,
  atLeast,
  isLevel,
  moreSensitive,
  rank,
} from './level.js';

export {
  type Classified,
  type Fields,
  type Registry,
  classify,
  registry,
} from './registry.js';

export { redactClassified, sensitiveKeys } from './redaction.js';
