/**
 * What an event is, and what it may be called. **L2 substrate.**
 *
 * `<context>.<entity>.<verb>` — `identity.user.registered`,
 * `orgs.membership.revoked`. Rule `M6` checks that the prefix matches the
 * context whose `domain/` defines the constant, which is why the shape is
 * validated here rather than left to convention.
 *
 * **Payloads are primitives only.** Not a style preference: a payload crosses a
 * process boundary, is stored for the lifetime of an audit record, and is read
 * by a subscriber compiled against a different version of the code. A `Date`
 * serializes three ways, a class instance serializes to `{}`, and a nested
 * entity invites a consumer to depend on a shape the publisher never promised.
 *
 * See `notes/patterns/events.md`.
 */

import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/** What may travel in a payload. */
export type Primitive = string | number | boolean | null;

export type Payload = Readonly<
  Record<string, Primitive | readonly Primitive[]>
>;

/**
 * `<context>.<entity>.<verb>`, each segment lowercase.
 *
 * Three segments exactly. Two is ambiguous about which half is the context, and
 * four invites a hierarchy that nothing consumes.
 */
const NAME = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface Event {
  readonly name: string;
  readonly payload: Payload;
}

/** The context a name belongs to — the segment `M6` compares. */
export function contextOf(name: string): string {
  return name.split('.')[0] ?? '';
}

export function isEventName(name: string): boolean {
  return NAME.test(name);
}

/**
 * An event, or why it is not one.
 *
 * A `Result` rather than a throw: a name is usually a constant, so this fails
 * at boot in the composition root or in a test, which is where a naming mistake
 * should be found.
 */
export function event(name: string, payload: Payload = {}): Result<Event> {
  if (!isEventName(name)) {
    return err(
      invalid(
        `${name} is not <context>.<entity>.<verb> with lowercase segments`,
      ),
    );
  }

  for (const [key, value] of Object.entries(payload)) {
    if (!isPrimitiveOrArray(value)) {
      return err(
        invalid(
          `${name}: payload.${key} is a ${describe(value)} — payloads carry primitives only`,
        ),
      );
    }
  }

  return ok({ name, payload });
}

function isPrimitive(value: unknown): value is Primitive {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isPrimitiveOrArray(value: unknown): boolean {
  return Array.isArray(value) ? value.every(isPrimitive) : isPrimitive(value);
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array of non-primitives';
  if (value instanceof Date) return 'Date — send an ISO string';
  return typeof value === 'object' ? 'nested object' : typeof value;
}
