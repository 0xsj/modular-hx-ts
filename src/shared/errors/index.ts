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
 * Adding a kind is a real decision, and not one a repository takes alone: the
 * set is collection-wide, because a dashboard filtering `err_kind` across
 * blueprints is filtering one vocabulary or none. **Eleven values, fixed by
 * collection decision 0010** — see `docs/decisions/0006-kind-vocabulary-is-ten.md`,
 * which this repository raised and which 0010 supersedes in the direction it
 * argued.
 *
 * **Twelve here, and the twelfth is a proposal rather than a local decision.**
 * `precondition_failed` is needed by conformance case 29, which requires 412
 * against a case 3 table that has none — the same contradiction 0010 resolved
 * for 422. See `docs/decisions/0011-precondition-failed-kind.md`, which takes
 * the posture ADR 0006 took and 0010 rewarded: implement, mark `Proposed`,
 * escalate.
 *
 * Every edge that maps kinds to a protocol gains a case, and forgetting one is
 * how a new failure silently becomes a 500. That totality is the whole reason
 * this is a `Kind` rather than a status carried on the error.
 */
export const Kind = {
  /** The request could not be **understood**. Malformed, unparseable, absent. */
  Invalid: 'invalid',
  /**
   * Understood, and refused.
   *
   * The distinction HTTP draws between 400 and 422, and it is a real one: if
   * you are reaching for `Invalid` and the request parsed fine, this is the one
   * you want. The type specimen is conformance case 26 — an idempotency key and
   * a payload that are each perfectly well-formed, and it is their disagreement
   * that cannot be acted on.
   */
  Unprocessable: 'unprocessable',
  /** No credentials, or credentials that do not identify anyone. */
  Unauthenticated: 'unauthenticated',
  /** Identified, but not permitted. Distinct from Unauthenticated on purpose. */
  Forbidden: 'forbidden',
  /** The thing does not exist, or the caller may not know that it does. */
  NotFound: 'not_found',
  /** The state moved: a version mismatch, a uniqueness violation. */
  Conflict: 'conflict',
  /**
   * A validator the caller supplied no longer describes the current state.
   *
   * Distinct from `Conflict`, and the distinction is worth keeping: a conflict
   * is *the state moved and your write cannot be applied*; this is *you told me
   * what you expected to find, and it is not what is here*. The caller's next
   * move differs — re-read and re-decide, rather than retry.
   *
   * **Proposed, not settled.** See ADR 0011.
   */
  PreconditionFailed: 'precondition_failed',
  /**
   * The route requires a precondition and the caller supplied none.
   *
   * RFC 6585 §3 — *the origin server requires the request to be conditional*.
   * Distinct again from `PreconditionFailed`: that one says *the validator you
   * sent is stale*, this says *you sent none, and this route will not let you
   * write blind*. The caller's next move is the most different of the three —
   * read the resource, take its `ETag`, and repeat the write with `If-Match`.
   *
   * **It was `Invalid`, and 400 was wrong.** `CONFORMANCE.md` §3.5 marks
   * `PATCH /v1/users/{id}` *`If-Match` required*, so a client that omits one is
   * doing something the surface anticipates and can recover from — but 400
   * tells it the request was malformed, which invites a developer to go looking
   * at their JSON. The slug said `precondition-required` beside a status that
   * did not; the comment beside it claimed *the slug carries the distinction
   * the status cannot*, which was simply untrue — 428 is the status, and the
   * vocabulary had no value for it.
   *
   * **Proposed, not settled.** See ADR 0013, which follows 0011 exactly.
   */
  PreconditionRequired: 'precondition_required',
  /** A limit was reached — rate limit, quota, budget. */
  /**
   * **`rate_limited`, and it was `exhausted` for six phases.**
   *
   * Decision 0010 fixed the vocabulary at eleven values and named this one;
   * this repository spelled it `exhausted`, which reads better and is not the
   * word. The divergence was reported twice and never resolved either way, and
   * it stayed invisible because nothing published a `Kind` on the wire — until
   * problem types became `/problems/<slug>` and a conformance run printed
   * `/problems/rate-limited` at a runner expecting the collection's spelling.
   *
   * The constructor keeps the name `exhausted`, which is what call sites read;
   * only the value crosses a boundary.
   */
  RateLimited: 'rate_limited',
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
  /**
   * The problem type slug, when this failure has a **named** one.
   *
   * `CONFORMANCE.md` §3.5 fixes a catalogue — `invalid-credentials`,
   * `token-expired`, `session-revoked`, `version-conflict`,
   * `idempotency-in-flight`, `idempotency-mismatch`, `invalid-cursor` — and it
   * is deliberately **finer than `Kind`**: a wrong password and a missing
   * header are both `Unauthenticated`, and a client branching on `type` needs
   * to tell them apart. RFC 9457 makes `type` the stable identifier, which is
   * exactly why it cannot be a rename of the status.
   *
   * Absent means the kind's own slug, kebab-cased. The value is a slug, not a
   * URI: rendering it is transport's job, and `I7` keeps that here.
   */
  readonly problem?: string;
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
  /** The named problem slug, or absent for the kind's own. See above. */
  readonly problem: string | undefined;

  constructor(kind: Kind, message: string, options: AppErrorOptions = {}) {
    // Only pass `cause` when there is one: with exactOptionalPropertyTypes an
    // explicit undefined is not the same as an absent property, and an
    // `Error` with `cause: undefined` prints a misleading empty chain.
    super(message, 'cause' in options ? { cause: options.cause } : undefined);

    this.kind = kind;
    this.fields = options.fields ?? [];
    this.details = options.details ?? {};
    this.problem = options.problem;
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

export const unprocessable = constructorFor(Kind.Unprocessable);
export const unauthenticated = constructorFor(Kind.Unauthenticated);
export const forbidden = constructorFor(Kind.Forbidden);
export const notFound = constructorFor(Kind.NotFound);
export const conflict = constructorFor(Kind.Conflict);
export const preconditionFailed = constructorFor(Kind.PreconditionFailed);
export const preconditionRequired = constructorFor(Kind.PreconditionRequired);
export const exhausted = constructorFor(Kind.RateLimited);
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
 * Whether the failure is **ours** rather than the caller's.
 *
 * Decided here for the same reason `isRetryable` is: two modules that each
 * invent it drift, and this one is read by `idempotency` to choose between
 * releasing a key and holding it. Kept as a predicate over `Kind` rather than a
 * comparison against a status code, because `errors` is L0 and the moment the
 * kernel knows what 500 is, the kernel knows about HTTP (invariant `I7`).
 *
 * `Canceled` is deliberately absent: the caller going away is neither our fault
 * nor theirs, and nothing downstream should treat it as either.
 */
export function isServerFault(error: unknown): boolean {
  const kind = kindOf(error);
  return (
    kind === Kind.Internal || kind === Kind.Unavailable || kind === Kind.Timeout
  );
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
