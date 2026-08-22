/**
 * Typed readers for configuration values. **L1 runtime.**
 *
 * Every environment variable is a string. A reader says what that string is
 * supposed to mean, what it should be when absent, and what to say when it is
 * neither — and that last part is most of the value, because the audience for a
 * configuration error is someone with a broken deploy at an unhelpful hour.
 *
 * Readers are **declared by the component that needs the value**, not centrally
 * (`../../../MODULES.md`: *components declare their own schema*). The composition
 * root assembles them; nothing owns a list of every variable in the system.
 *
 * See `notes/patterns/env.md`.
 */

import { millis, type Millis } from '../clock/index.js';
import { type Secret, secret } from '../redact/index.js';

/**
 * What went wrong with one variable.
 *
 * Deliberately a value rather than a thrown error: `load` collects every one of
 * these before reporting, so a broken deploy is fixed in a single pass instead
 * of one variable per restart.
 */
export interface Problem {
  readonly variable: string;
  readonly message: string;
}

export interface Reader<T> {
  readonly variable: string;
  /** Whether the value is safe to show in a diagnostic listing. */
  readonly sensitive: boolean;
  read(raw: string | undefined): { value: T } | { problem: string };
}

interface Options<T> {
  /** Used when the variable is absent. Absent and empty are different. */
  readonly fallback?: T;
}

/**
 * Absent and present-but-blank both mean "not set".
 *
 * `PORT=` in a compose file is the same statement as omitting the line, and a
 * reader that treated the empty string as a value would report
 * `is not a whole number:` with nothing after the colon.
 */
const trimmed = (raw: string | undefined): string => raw?.trim() ?? '';

function reader<T>(
  variable: string,
  options: Options<T>,
  parse: (raw: string) => { value: T } | { problem: string },
  sensitive = false,
): Reader<T> {
  return {
    variable,
    sensitive,
    read: (raw) => {
      const value = trimmed(raw);
      if (value === '') {
        return options.fallback === undefined
          ? { problem: 'is required' }
          : { value: options.fallback };
      }
      return parse(value);
    },
  };
}

// --- readers ---------------------------------------------------------------

export function text(variable: string, options: Options<string> = {}) {
  return reader<string>(variable, options, (raw) => ({ value: raw }));
}

/**
 * A whole number, with optional bounds.
 *
 * Rejects `8080abc` rather than reading `8080` from it, because a value that is
 * *nearly* a number is a typo, and silently truncating one is how a service
 * ends up listening on a port nobody chose.
 */
export function integer(
  variable: string,
  options: Options<number> & {
    readonly min?: number;
    readonly max?: number;
  } = {},
) {
  return reader<number>(variable, options, (raw) => {
    if (!/^-?\d+$/.test(raw))
      return { problem: `is not a whole number: ${raw}` };

    const value = Number(raw);
    if (options.min !== undefined && value < options.min) {
      return { problem: `is below the minimum of ${String(options.min)}` };
    }
    if (options.max !== undefined && value > options.max) {
      return { problem: `is above the maximum of ${String(options.max)}` };
    }
    return { value };
  });
}

const TRUE = new Set(['true', '1', 'yes', 'on']);
const FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * A flag.
 *
 * Accepts what people actually write in a compose file, and **refuses anything
 * else** rather than treating it as false — `FEATURE=treu` silently off is
 * worse than a startup failure that names the variable.
 */
export function flag(variable: string, options: Options<boolean> = {}) {
  return reader<boolean>(variable, options, (raw) => {
    const lowered = raw.toLowerCase();
    if (TRUE.has(lowered)) return { value: true };
    if (FALSE.has(lowered)) return { value: false };
    return { problem: `is not a boolean: ${raw}` };
  });
}

/**
 * One of a fixed set.
 *
 * The error lists the alternatives, because the next thing anyone does after
 * reading "is not valid" is go looking for what would be.
 */
export function oneOf<const T extends string>(
  variable: string,
  allowed: readonly T[],
  options: Options<T> = {},
) {
  return reader<T>(variable, options, (raw) =>
    (allowed as readonly string[]).includes(raw)
      ? { value: raw as T }
      : { problem: `is not one of ${allowed.join(', ')}: ${raw}` },
  );
}

/** A URL, validated by parsing it rather than by a regex nobody can read. */
export function url(variable: string, options: Options<string> = {}) {
  return reader<string>(variable, options, (raw) => {
    if (!URL.canParse(raw)) return { problem: 'is not a valid URL' };
    return { value: raw };
  });
}

const DURATION = /^(\d+)(ms|s|m|h)?$/;
const UNIT: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * A duration, written the way people write durations.
 *
 * `30s`, `500ms`, `2m`, `1h` — and a bare number is milliseconds. Returns
 * `Millis`, so a value read as seconds cannot be passed where milliseconds are
 * expected: the unit mix-up is the most common time bug there is.
 */
export function duration(variable: string, options: Options<Millis> = {}) {
  return reader<Millis>(variable, options, (raw) => {
    const match = DURATION.exec(raw.toLowerCase());
    if (match === null) {
      return { problem: `is not a duration: ${raw} (try 30s, 500ms, 2m, 1h)` };
    }

    const amount = Number(match[1]);
    const unit = UNIT[match[2] ?? 'ms'] ?? 1;
    return { value: millis(amount * unit) };
  });
}

/**
 * A value that must never print.
 *
 * Returns a `Secret`, so it is `[redacted]` through every path to text —
 * `../../../ARCHITECTURE.md` §8: *secrets self-redact*. Marked sensitive, so a
 * diagnostic listing shows that it is set without showing what it is.
 *
 * There is deliberately no fallback: a default credential is either useless or
 * dangerous, and both are worse than being told it is missing.
 */
export function sensitive(variable: string) {
  return reader<Secret<string>>(
    variable,
    {},
    (raw) => ({ value: secret(raw) }),
    true,
  );
}

// --- combinators -----------------------------------------------------------

/**
 * A value that may legitimately be absent.
 *
 * Distinct from a fallback: `undefined` here means "this feature is off", which
 * is a different statement from "use this value when unset".
 */
export function optional<T>(inner: Reader<T>): Reader<T | undefined> {
  return {
    variable: inner.variable,
    sensitive: inner.sensitive,
    read: (raw) =>
      trimmed(raw) === '' ? { value: undefined } : inner.read(raw),
  };
}
