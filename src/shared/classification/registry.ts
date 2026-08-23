/**
 * Declaring a field's level. **L3 capability.**
 *
 * **Declaration, never inference.** There is no heuristic over field names here
 * and there must never be one: a guesser that sees `email` and infers PII will
 * also see `email_template_id` and get it wrong in the direction that leaks.
 * The registry is explicit and reviewable, and a reviewer can see the whole
 * thing in one place.
 *
 * **Exhaustive by type.** `classify<T>` takes a `Record<keyof T, Level>`, so
 * adding a field to a type and forgetting to classify it **fails to compile**.
 * That is rule `M9` enforced by the type system rather than by a lint pass —
 * decorators would have been the other idiomatic option and `erasableSyntaxOnly`
 * forbids them, which turned out to be the better constraint.
 *
 * See `notes/patterns/classification.md`.
 */

import { invariant } from '../assert/index.js';
import { atLeast, type Level, UNCLASSIFIED } from './level.js';

/**
 * Every field of `T`, classified.
 *
 * `Record<keyof T, Level>` and not `Partial<...>`: the missing entry is the
 * whole failure mode.
 */
export type Fields<T> = Readonly<Record<keyof T & string, Level>>;

export interface Classified<T> {
  /** The type's name, as it appears in a catalog and in an audit record. */
  readonly type: string;
  readonly fields: Fields<T>;
}

/**
 * Classify a type's fields.
 *
 * ```ts
 * export const USER = classify<User>('identity.User', {
 *   id: Level.Internal,
 *   email: Level.Pii,
 *   passwordHash: Level.Secret,
 * });
 * ```
 *
 * Omitting `passwordHash` is a compile error, not a review finding.
 */
export function classify<T>(type: string, fields: Fields<T>): Classified<T> {
  invariant(type !== '', 'a classified type is named');
  return { type, fields };
}

/**
 * Several classified types, looked up together.
 *
 * What a composition root assembles and what `redact`, `exports` and the rest
 * are handed. One registry per process, so two subsystems cannot hold different
 * opinions about the same field.
 */
export interface Registry {
  /** The level of `type.field`, or the fail-closed default. */
  levelOf(type: string, field: string): Level;
  /** Every field at or above `threshold`, as `type.field`. */
  at(threshold: Level): readonly string[];
  /** Just the field names at or above `threshold`, deduplicated. */
  fieldNamesAt(threshold: Level): readonly string[];
  types(): readonly string[];
}

export function registry(
  ...classified: readonly Classified<never>[]
): Registry {
  const byType = new Map<string, Readonly<Record<string, Level>>>();

  for (const one of classified) {
    invariant(!byType.has(one.type), `a type is classified once: ${one.type}`);
    byType.set(one.type, one.fields);
  }

  const entries = (): readonly [string, string, Level][] =>
    [...byType.entries()].flatMap(([type, fields]) =>
      Object.entries(fields).map(
        ([field, level]) => [type, field, level] as const,
      ),
    );

  return {
    levelOf(type, field) {
      // **Fail closed.** An unknown field is treated as the most sensitive
      // level, not the least — see `UNCLASSIFIED`.
      return byType.get(type)?.[field] ?? UNCLASSIFIED;
    },

    at(threshold) {
      return entries()
        .filter(([, , level]) => atLeast(level, threshold))
        .map(([type, field]) => `${type}.${field}`)
        .sort();
    },

    fieldNamesAt(threshold) {
      return [
        ...new Set(
          entries()
            .filter(([, , level]) => atLeast(level, threshold))
            .map(([, field]) => field),
        ),
      ].sort();
    },

    types: () => [...byType.keys()].sort(),
  };
}
