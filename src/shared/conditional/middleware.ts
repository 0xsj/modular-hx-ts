/**
 * Position 9, beside `idempotency`. **L4 edge.**
 *
 * `../../../MODULES.md` §5 puts `conditional` at 9, and it runs **inside**
 * `idempotency` rather than outside it. That ordering is a decision, so it is
 * stated here rather than left to be inferred: a replayed idempotent request
 * must return the stored response **bit for bit**, and re-evaluating its
 * preconditions against state that has moved on since would turn a replay into
 * a 412. The original request's preconditions were evaluated once, when they
 * meant something.
 *
 * The cost is that a *fresh* request behind an idempotency key claims the key
 * before its preconditions are checked, so a 412 spends a key. That is the
 * cheaper of the two: a spent key is recoverable by using a new one, and a
 * replay that returns 412 instead of the original answer is not recoverable at
 * all.
 *
 * See `notes/patterns/conditional.md`.
 */

import { preconditionFailed } from '../errors/index.js';
import {
  type Exchange,
  type Middleware,
  type Response,
} from '../edge/index.js';
import { formatETag } from './etag.js';
import { evaluate, type Preconditions } from './preconditions.js';
import { type Validators } from './validators.js';

export interface ConditionalOptions {
  /**
   * **Has no implementation in this repository yet**, and that is deliberate.
   * See `validators.ts`.
   */
  readonly validators: Validators;
}

/** Lift the six fields §13.2.2 names, and nothing else. */
function preconditionsOf(
  headers: Readonly<Record<string, string>>,
): Preconditions {
  return {
    ...(headers['if-match'] === undefined
      ? {}
      : { ifMatch: headers['if-match'] }),
    ...(headers['if-none-match'] === undefined
      ? {}
      : { ifNoneMatch: headers['if-none-match'] }),
    ...(headers['if-modified-since'] === undefined
      ? {}
      : { ifModifiedSince: headers['if-modified-since'] }),
    ...(headers['if-unmodified-since'] === undefined
      ? {}
      : { ifUnmodifiedSince: headers['if-unmodified-since'] }),
    ...(headers['if-range'] === undefined
      ? {}
      : { ifRange: headers['if-range'] }),
    ...(headers['range'] === undefined ? {} : { range: headers['range'] }),
  };
}

/** Present when any of the six is. */
function anyPresent(preconditions: Preconditions): boolean {
  return Object.keys(preconditions).length > 0;
}

const SAFE = new Set(['GET', 'HEAD']);

export function conditional(options: ConditionalOptions): Middleware {
  const { validators } = options;

  return async (exchange: Exchange, next): Promise<Response> => {
    const preconditions = preconditionsOf(exchange.request.headers);
    const safe = SAFE.has(exchange.request.method.toUpperCase());

    // Nothing to evaluate and nothing to advertise: a mutating request with no
    // preconditions needs no validator, and asking for one would put a read in
    // front of every write for no reason.
    if (!anyPresent(preconditions) && !safe) return next(exchange);

    const validator = await validators(exchange);
    const outcome = evaluate(exchange.request.method, preconditions, validator);

    switch (outcome.kind) {
      case 'precondition-failed':
        // Thrown, so conformance case 29's 412 is built by the same mapper as
        // every other error and carries the same request id — position 9 is
        // below position 3 precisely so it is.
        //
        // **`version-conflict`, not `precondition-failed`.** The slug is the
        // one a *repository* raises when an optimistic update loses, and that
        // is deliberate: a caller who held a stale validator lost the same race
        // whether the loss was detected here, from a header, or three layers
        // down, from a `where version = $n` that matched no row. One slug means
        // one branch in the client — re-read and retry — instead of two that
        // mean the same thing and are reached by different paths.
        throw preconditionFailed(
          'a precondition on this request does not hold',
          { problem: 'version-conflict' },
        );

      case 'not-modified':
        // **304 carries the validator and no body** (case 30). RFC 9110
        // §15.4.5: a 304 sends the header fields that would have been sent in a
        // 200, which is how a cache updates its stored metadata without a
        // transfer.
        return {
          status: 304,
          headers:
            validator === undefined ? {} : { etag: formatETag(validator.etag) },
          body: '',
        };

      case 'proceed':
        break;
    }

    const response = await next(exchange);
    if (response.headers['etag'] !== undefined) {
      // A handler that set its own knows something this position does not.
      return response;
    }

    // **Case 30's first half.** A GET that returns no `ETag` is a GET no client
    // can revalidate, so the tag the evaluation just used is the tag the
    // response carries.
    if (safe && validator !== undefined) {
      return {
        ...response,
        headers: { ...response.headers, etag: formatETag(validator.etag) },
      };
    }

    // **A successful write answers with the NEW tag**, re-derived rather than
    // reused: the one computed before the handler described the representation
    // that has just been replaced, and attaching it would hand a client a
    // validator that is stale the moment it arrives.
    //
    // The reason to bother is chaining. A client that writes and then writes
    // again otherwise has to `GET` in between purely to learn a tag the server
    // already knew — conformance case 29 asks for it on the mutating step for
    // exactly that.
    if (!safe && validator !== undefined && response.status < 300) {
      const fresh = await options.validators(exchange);
      if (fresh !== undefined) {
        return {
          ...response,
          headers: { ...response.headers, etag: formatETag(fresh.etag) },
        };
      }
    }

    return response;
  };
}
