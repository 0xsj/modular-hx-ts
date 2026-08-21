/**
 * Kind-tagged errors. **L0 kernel** — pure, no I/O, no process state.
 *
 * Invariant I7: errors are typed at the domain boundary, wrapped with context
 * at each layer, and mapped to transport codes **only in transport**. This
 * module therefore has no status codes in it, and must not grow any. The moment
 * `errors` knows what 404 is, the kernel knows about HTTP.
 *
 * The only module a context's `domain/` may import (rule S7).
 *
 * See `notes/patterns/errors.md`.
 */

/**
 * The closed vocabulary of failure.
 *
 * A `const` object with a derived union rather than an `enum`: `enum` is not
 * erasable, and `erasableSyntaxOnly` keeps the program identical for tsc,
 * esbuild and `node --experimental-strip-types`.
 *
 * Adding a kind is a real decision. Every edge that maps kinds to a protocol
 * gains a case, and forgetting one is how a new failure silently becomes a 500.
 */
export const Kind = {
  /** Input failed validation. The caller can fix it. */
  Invalid: 'invalid',
  /** No credentials, or credentials that do not identify anyone. */
  Unauthenticated: 'unauthenticated',
  /** Identified, but not permitted. Distinct from Unauthenticated on purpose. */
  Forbidden: 'forbidden',
  /** The thing does not exist, or the caller may not know that it does. */
  NotFound: 'not_found',
  /** The state moved: a version mismatch, a uniqueness violation. */
  Conflict: 'conflict',
  /** A limit was reached — rate limit, quota, budget. */
  Exhausted: 'exhausted',
  /** A dependency is down or degraded. Nothing is wrong with the request. */
  Unavailable: 'unavailable',
  /** A deadline passed before the work finished. */
  Timeout: 'timeout',
  /** The caller went away, or a parent operation was abandoned. */
  Canceled: 'canceled',
  /** A bug. The bucket, and the only kind that should page anyone. */
  Internal: 'internal',
} as const;

export type Kind = (typeof Kind)[keyof typeof Kind];

const KINDS: readonly Kind[] = Object.values(Kind);

/** Narrow an untrusted string — a config value, a serialized envelope. */
export function isKind(value: unknown): value is Kind {
  return (
    typeof value === 'string' && (KINDS as readonly string[]).includes(value)
  );
}

/**
 * One problem with one input.
 *
 * Validation collects every problem rather than stopping at the first: a form
 * that reports one error per round trip is a form nobody finishes.
 */
export interface FieldIssue {
  /** Dotted path into the input: `email`, `address.postcode`, `items.0.sku`. */
  readonly field: string;
  readonly message: string;
}

export interface AppErrorOptions {
  /** The error being wrapped. Chained via the standard `cause`. */
  readonly cause?: unknown;
  /** Every field problem, for `Invalid`. */
  readonly fields?: readonly FieldIssue[];
  /**
   * Structured context for logs. Never anything secret: this module cannot
   * redact, and `redact` is a sibling at the same layer rather than a
   * dependency, so nothing here can enforce that for you.
   */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * An error carrying a `Kind`.
 *
 * Pattern: **tagged union**, expressed as a class so `instanceof` and the
 * standard `cause` chain both work. Failures that are expected are returned as
 * values through `result`; this is what those values carry, and what genuinely
 * exceptional paths throw.
 */
export class AppError extends Error {
  override readonly name = 'AppError';

  readonly kind: Kind;
  readonly fields: readonly FieldIssue[];
  readonly details: Readonly<Record<string, unknown>>;

  constructor(kind: Kind, message: string, options: AppErrorOptions = {}) {
    // Only pass `cause` when there is one: with exactOptionalPropertyTypes an
    // explicit undefined is not the same as an absent property, and an
    // `Error` with `cause: undefined` prints a misleading empty chain.
    super(message, 'cause' in options ? { cause: options.cause } : undefined);

    this.kind = kind;
    this.fields = options.fields ?? [];
    this.details = options.details ?? {};
  }
}

// --- constructors ----------------------------------------------------------
//
// One per kind, so a call site names the failure rather than passing a string
// tag. `invalid` takes field issues because that is the only kind that has any.

export const invalid = (
  message: string,
  fields: readonly FieldIssue[] = [],
  options: AppErrorOptions = {},
): AppError => new AppError(Kind.Invalid, message, { ...options, fields });

const constructorFor =
  (kind: Kind) =>
  (message: string, options: AppErrorOptions = {}): AppError =>
    new AppError(kind, message, options);

export const unauthenticated = constructorFor(Kind.Unauthenticated);
export const forbidden = constructorFor(Kind.Forbidden);
export const notFound = constructorFor(Kind.NotFound);
export const conflict = constructorFor(Kind.Conflict);
export const exhausted = constructorFor(Kind.Exhausted);
export const unavailable = constructorFor(Kind.Unavailable);
export const timeout = constructorFor(Kind.Timeout);
export const canceled = constructorFor(Kind.Canceled);
export const internal = constructorFor(Kind.Internal);

// --- inspection ------------------------------------------------------------

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * The kind of any thrown value.
 *
 * Anything that is not an `AppError` is `Internal`, because an error that
 * escaped without a kind escaped without anyone deciding what it means. This is
 * the function transport calls before mapping to a status code.
 */
export function kindOf(error: unknown): Kind {
  return isAppError(error) ? error.kind : Kind.Internal;
}

export function hasKind(error: unknown, kind: Kind): boolean {
  return kindOf(error) === kind;
}

/**
 * Whether retrying could plausibly succeed without the caller changing
 * anything.
 *
 * Decided here, once, so `retry` and `breaker` read the same answer instead of
 * each inventing one. `Conflict` is excluded deliberately: retrying a version
 * mismatch without re-reading state reproduces it.
 */
export function isRetryable(error: unknown): boolean {
  const kind = kindOf(error);
  return kind === Kind.Unavailable || kind === Kind.Timeout;
}

/**
 * Add context while crossing a layer boundary (invariant I7).
 *
 * The kind is preserved — a `NotFound` from the repository is still a
 * `NotFound` to the use case that called it — along with fields and details.
 * A value that is not an `AppError` becomes `Internal`, which is the honest
 * reading: nobody classified it.
 *
 * Messages read outside-in once chained, which is the order they are useful:
 * `load user: query user by id: connection refused`.
 */
export function wrap(error: unknown, message: string): AppError {
  if (isAppError(error)) {
    return new AppError(error.kind, `${message}: ${error.message}`, {
      cause: error,
      fields: error.fields,
      details: error.details,
    });
  }

  const description = error instanceof Error ? error.message : String(error);

  return new AppError(Kind.Internal, `${message}: ${description}`, {
    cause: error,
  });
}

/**
 * The chain, outermost first. What a log line prints, and what a test asserts
 * against when it wants the root cause rather than the wrapper.
 */
export function chain(error: unknown): readonly unknown[] {
  const seen = new Set<unknown>();
  const out: unknown[] = [];

  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }

  return out;
}

/** The innermost cause: the thing that actually went wrong. */
export function rootCause(error: unknown): unknown {
  return chain(error).at(-1);
}
