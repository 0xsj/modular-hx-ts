/**
 * Wiring `classification` to `redact`. **L3 capability.**
 *
 * **This file exists because of the layer rule, not in spite of it.**
 *
 * `redact` is L0 and `classification` is L3, so `redact` cannot import this —
 * `S1` forbids the upward import, permanently. The temptation is to move
 * `redact` up a layer to make the dependency legal. Written down instead, as
 * asked:
 *
 * > **Redaction is a mechanism; classification is a vocabulary.**
 *
 * `redact` knows *how* to make a value unprintable — four stringification
 * paths, a `#private` field, a cycle-safe walk. It has no business knowing
 * *which* values deserve that, and it is used by `logger` at L1, far below any
 * layer that could name a domain type. Moving it up would drag `logger` up with
 * it, and `logger` cannot be above the modules that log.
 *
 * So the vocabulary is supplied **here**, at the first layer that can see both,
 * and handed to `redact` as data. The consumer holds the mapping; the mechanism
 * stays where everything can reach it.
 *
 * See `notes/patterns/classification.md`.
 */

import { redactKeys, SENSITIVE_KEYS } from '../redact/index.js';
import { Level } from './level.js';
import { type Registry } from './registry.js';

/**
 * The key list `redact` should treat as sensitive, for this registry.
 *
 * Unions the classified field names at or above `threshold` with `redact`'s own
 * built-in fragments. **Union, not replacement**: the built-in list is a
 * backstop for values that never went near a classified type — a raw header
 * map, a third-party payload — and a registry that replaced it would quietly
 * un-protect everything nobody had classified yet.
 */
export function sensitiveKeys(
  registry: Registry,
  threshold: Level = Level.Pii,
): readonly string[] {
  return [
    ...new Set([
      ...SENSITIVE_KEYS,
      ...registry.fieldNamesAt(threshold).map(normalise),
    ]),
  ].sort();
}

/**
 * A field name in the form `redact` matches against.
 *
 * `redact` normalises the **key** — lowercased, separators stripped, so
 * `X-Api-Key`, `api_key` and `apiKey` are one thing — and then matches the
 * fragment against it **as given**. So a fragment carrying a capital or an
 * underscore can never match anything.
 *
 * A registry declares fields as they are spelled in the type, which in
 * TypeScript is camelCase. `displayName` therefore matched nothing until this
 * existed, and the field was printed in full while the registry said it was
 * PII — a retrofit that looked wired and was not.
 */
function normalise(field: string): string {
  return field.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * `redactKeys`, driven by the registry.
 *
 * The one call a consumer at L3 or above makes instead of reaching for
 * `redact`'s defaults directly.
 */
export function redactClassified(
  value: unknown,
  registry: Registry,
  threshold: Level = Level.Pii,
): unknown {
  return redactKeys(value, sensitiveKeys(registry, threshold));
}
