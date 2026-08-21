/**
 * Expected failures as values. **L0 kernel** — pure, no I/O, no process state.
 *
 * TypeScript-only. Go returns `(T, error)` and the compiler nags you about the
 * second half; TypeScript has no such habit, so the discipline has to be a type.
 *
 * The rule this encodes: **a failure you expected is a value; a failure you did
 * not is a throw.** A repository returning "no such user" returns an `Err`. A
 * repository whose connection pool is corrupt throws, because no caller planned
 * for that and pretending otherwise just moves the crash.
 *
 * Same-layer dependency on `errors`, deliberately: `E` defaults to `AppError`
 * and `attempt` classifies through `wrap`. Rule S1 permits L0 → L0. See
 * `notes/patterns/result.md`.
 */

import { type AppError, wrap } from '../errors/index.js';

export interface Ok<out T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<out E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * A discriminated union, not a class.
 *
 * `ok` is the discriminant, so `if (result.ok)` narrows with no import and no
 * method call — which means a `Result` survives `JSON.stringify`, crosses a
 * process boundary, and reads the same in a debugger as it does in source.
 */
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });

export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

// --- transforming ----------------------------------------------------------

/** Change the value, leave a failure untouched. */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Change the failure, leave a value untouched. */
export function mapError<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F,
): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/**
 * Chain a step that can itself fail, without nesting the results.
 *
 * This is what a use case is made of: each step returns a `Result`, and the
 * first failure short-circuits the rest.
 */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

// --- consuming -------------------------------------------------------------

/** Handle both sides. The exhaustive way out of a `Result`. */
export function match<T, E, A>(
  result: Result<T, E>,
  handlers: { readonly ok: (value: T) => A; readonly err: (error: E) => A },
): A {
  return result.ok ? handlers.ok(result.value) : handlers.err(result.error);
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

export function unwrapOrElse<T, E>(
  result: Result<T, E>,
  fn: (error: E) => T,
): T {
  return result.ok ? result.value : fn(result.error);
}

/**
 * The value, or throw the failure.
 *
 * For tests and for the composition root, where there is no caller left to
 * return to. Reaching for it inside a use case means the failure was expected
 * after all, and should have been handled.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (result.ok) return result.value;

  // `E` is unconstrained, so the failure is not necessarily an Error. Throwing
  // a bare string loses the stack and every catch upstream that expected one,
  // so anything else is classified on the way out.
  throw result.error instanceof Error
    ? result.error
    : wrap(result.error, 'unwrap');
}

// --- collections -----------------------------------------------------------

/**
 * Every value, or the first failure.
 *
 * First-failure, not every-failure, on purpose: these are steps, and step three
 * running after step two failed is the bug this type exists to prevent. Reports
 * that collect every problem — a form, a request body — are validation, and
 * `AppError.fields` already carries them.
 *
 * O(n), and stops at the first failure.
 */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];

  for (const result of results) {
    if (!result.ok) return result;
    values.push(result.value);
  }

  return ok(values);
}

// --- boundaries ------------------------------------------------------------

/**
 * Run something that throws, and get a `Result` back.
 *
 * The adapter boundary in one function: third-party code throws, this side
 * returns values. `message` becomes the wrapping context, so the failure
 * arrives already classified and already located.
 */
export function attempt<T>(operation: () => T, message: string): Result<T> {
  try {
    return ok(operation());
  } catch (error) {
    return err(wrap(error, message));
  }
}

/** `attempt`, for the asynchronous case — which is most of them. */
export async function attemptAsync<T>(
  operation: () => Promise<T>,
  message: string,
): Promise<Result<T>> {
  try {
    return ok(await operation());
  } catch (error) {
    return err(wrap(error, message));
  }
}
