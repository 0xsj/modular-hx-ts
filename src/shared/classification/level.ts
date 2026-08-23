/**
 * The sensitivity vocabulary. **L3 capability.**
 *
 * A closed set of levels and a way to compare them. That is the whole module's
 * subject: it makes no decisions, performs no I/O, and enforces nothing on its
 * own. It exists so that `redact`, `fieldcrypt`, `readaudit`, `retention`,
 * `exports` and `cost` do not each invent their own answer to *is an email
 * address PII?*
 *
 * **Closed, like `errors.Kind`, and for the same reason.** A level ends up in
 * canonical bytes and in generated catalogs, so a growing enum is a
 * canonical-form change. Add one only with an ADR.
 *
 * See `notes/patterns/classification.md`.
 */

/**
 * Ordered, least to most sensitive.
 *
 * The order is the useful part: a consumer asks *at or above `pii`* rather than
 * enumerating the levels it cares about, so adding a level later does not
 * silently narrow every existing check.
 */
export const Level = {
  /** Safe to show anyone. A product name, a public id. */
  Public: 'public',
  /** Ours, not theirs. Internal ids, operational counters. */
  Internal: 'internal',
  /** Identifies a person. Email, name, address, device id. */
  Pii: 'pii',
  /** Grants access if disclosed. Tokens, keys, password hashes. */
  Secret: 'secret',
  /** Carries a legal obligation of its own. Card data, health, biometrics. */
  Regulated: 'regulated',
} as const;

export type Level = (typeof Level)[keyof typeof Level];

/** Least to most sensitive. The index is the comparison. */
const ORDER: readonly Level[] = [
  Level.Public,
  Level.Internal,
  Level.Pii,
  Level.Secret,
  Level.Regulated,
];

export const LEVELS = ORDER;

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && ORDER.includes(value as Level);
}

/** Where a level sits. Exported for a consumer that must sort. */
export function rank(level: Level): number {
  return ORDER.indexOf(level);
}

/**
 * Is `level` at least as sensitive as `threshold`?
 *
 * The question every consumer actually asks. `fieldcrypt` encrypts at or above
 * `pii`; `exports` refuses at or above `secret`; `readaudit` records a read at
 * or above `pii`. None of them enumerates.
 */
export function atLeast(level: Level, threshold: Level): boolean {
  return rank(level) >= rank(threshold);
}

/** The more sensitive of two. For a field that inherits from a container. */
export function moreSensitive(a: Level, b: Level): Level {
  return rank(a) >= rank(b) ? a : b;
}

/**
 * What an **unclassified** field is treated as.
 *
 * **The most sensitive, not the least.** An unlabelled field is not public: the
 * failure of guessing low is that data leaves the building looking compliant,
 * and the failure of guessing high is that somebody has to add a label. Only
 * one of those is recoverable after the fact.
 *
 * This is deliberately uncomfortable. It is meant to be — rule `M9` exists so
 * the default is approached rarely, and a system where it is hit constantly is
 * a system with an incomplete registry, which is the thing worth noticing.
 */
export const UNCLASSIFIED: Level = Level.Regulated;
