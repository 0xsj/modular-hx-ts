import { describe, expect, it } from 'vitest';
import {
  AppError,
  chain,
  canceled,
  conflict,
  forbidden,
  hasKind,
  internal,
  invalid,
  isAppError,
  isKind,
  isRetryable,
  isServerFault,
  Kind,
  kindOf,
  notFound,
  rootCause,
  timeout,
  unavailable,
  unprocessable,
  wrap,
  type FieldIssue,
} from './index.js';

// Realistic values, not foo/bar. A suite that only ever sees `foo` never asks
// the questions real data asks — see ../CONFORMANCE.md on fixtures.
const issues: readonly FieldIssue[] = [
  { field: 'email', message: 'must contain @' },
  { field: 'address.postcode', message: 'not a postcode: “SW1A 0AA!”' },
];

describe('Kind', () => {
  it('is decision 0010`s eleven, plus the two this repo proposes', () => {
    // **The pin conformance case 50 needs.** `err_kind` is one of these or the
    // profile is filtering a vocabulary that does not exist. Written out rather
    // than derived from `Kind` itself, because a test that reads the value it
    // is checking asserts nothing.
    expect(Object.values(Kind).sort()).toEqual(
      [
        'invalid',
        'unprocessable',
        'unauthenticated',
        'forbidden',
        'not_found',
        'conflict',
        'precondition_failed',
        'precondition_required',
        'rate_limited',
        'unavailable',
        'timeout',
        'canceled',
        'internal',
      ].sort(),
    );
  });

  it('narrows a string that names a kind', () => {
    expect(isKind('not_found')).toBe(true);
  });

  it('rejects a string that does not, including near misses', () => {
    expect(isKind('notfound')).toBe(false);
    expect(isKind('NOT_FOUND')).toBe(false);
    expect(isKind('')).toBe(false);
  });

  it('rejects non-strings, which is what a decoded envelope hands you', () => {
    expect(isKind(undefined)).toBe(false);
    expect(isKind(null)).toBe(false);
    expect(isKind(404)).toBe(false);
    expect(isKind({ kind: 'not_found' })).toBe(false);
  });
});

describe('AppError', () => {
  it('is an Error, so it survives every catch that already exists', () => {
    const error = notFound(
      'no user with id 01a024c7-d2d6-7e71-8c87-e344e27ef844',
    );

    expect(error).toBeInstanceOf(Error);
    expect(isAppError(error)).toBe(true);
    expect(error.name).toBe('AppError');
    expect(error.message).toContain('01a024c7');
  });

  it('carries the kind its constructor names', () => {
    expect(notFound('gone').kind).toBe(Kind.NotFound);
    expect(forbidden('not yours').kind).toBe(Kind.Forbidden);
    expect(conflict('version 7, expected 6').kind).toBe(Kind.Conflict);
  });

  it('defaults fields and details rather than leaving them undefined', () => {
    const error = notFound('gone');

    expect(error.fields).toEqual([]);
    expect(error.details).toEqual({});
  });

  it('collects every field problem, not just the first', () => {
    const error = invalid('the submitted profile is not valid', issues);

    expect(error.kind).toBe(Kind.Invalid);
    expect(error.fields).toHaveLength(2);
    expect(error.fields.map((f) => f.field)).toEqual([
      'email',
      'address.postcode',
    ]);
  });

  it('omits cause entirely when there is none', () => {
    // Not the same as `cause: undefined`, which prints an empty chain and
    // reads like a root cause somebody lost.
    expect('cause' in notFound('gone')).toBe(false);
  });

  it('keeps a cause that was given, including a non-Error one', () => {
    const cause = { code: 'ECONNREFUSED' };
    const error = new AppError(Kind.Unavailable, 'database unreachable', {
      cause,
    });

    expect(error.cause).toBe(cause);
  });
});

describe('kindOf', () => {
  it('reports the kind of an AppError', () => {
    expect(kindOf(timeout('deadline exceeded after 30s'))).toBe(Kind.Timeout);
  });

  it('calls anything unclassified internal, because nobody decided', () => {
    expect(kindOf(new TypeError('x is not a function'))).toBe(Kind.Internal);
    expect(kindOf('a thrown string')).toBe(Kind.Internal);
    expect(kindOf(undefined)).toBe(Kind.Internal);
  });

  it('answers hasKind for thrown values of any shape', () => {
    expect(hasKind(forbidden('not yours'), Kind.Forbidden)).toBe(true);
    expect(hasKind(forbidden('not yours'), Kind.NotFound)).toBe(false);
    expect(hasKind('a thrown string', Kind.Internal)).toBe(true);
  });
});

describe('isServerFault', () => {
  it('is true for the failures that are ours', () => {
    expect(isServerFault(internal('nil dereference'))).toBe(true);
    expect(isServerFault(unavailable('connection refused'))).toBe(true);
    expect(isServerFault(timeout('deadline exceeded'))).toBe(true);
    // An unclassified throw is `Internal`, and an unclassified throw is a bug.
    expect(isServerFault(new TypeError('x is not a function'))).toBe(true);
  });

  it('is false for the failures that are the caller`s', () => {
    expect(isServerFault(invalid('not JSON'))).toBe(false);
    expect(isServerFault(unprocessable('the key was used differently'))).toBe(
      false,
    );
    expect(isServerFault(notFound('no such user'))).toBe(false);
    expect(isServerFault(conflict('version 7, expected 6'))).toBe(false);
  });

  it('is false for a cancellation, which is nobody`s fault', () => {
    // The caller going away says nothing about our health or their request.
    // `idempotency` must not release a key on it, and `breaker` must not count
    // it — see decision 0010.
    expect(isServerFault(canceled('client hung up'))).toBe(false);
  });
});

describe('isRetryable', () => {
  it('is true where retrying could plausibly succeed unchanged', () => {
    expect(isRetryable(unavailable('connection refused'))).toBe(true);
    expect(isRetryable(timeout('deadline exceeded'))).toBe(true);
  });

  it('is false for a conflict, which retrying reproduces', () => {
    // Retrying a version mismatch without re-reading state hits the same
    // mismatch. This is the case the rule exists for.
    expect(isRetryable(conflict('version 7, expected 6'))).toBe(false);
  });

  it('is false for the caller’s own mistakes', () => {
    expect(isRetryable(invalid('bad email', issues))).toBe(false);
    expect(isRetryable(forbidden('not yours'))).toBe(false);
    expect(isRetryable(notFound('gone'))).toBe(false);
  });

  it('is false for anything unclassified', () => {
    expect(isRetryable(new Error('boom'))).toBe(false);
  });
});

describe('wrap', () => {
  it('preserves the kind across a layer boundary', () => {
    // A NotFound from the repository is still a NotFound to the use case.
    const wrapped = wrap(notFound('no row'), 'load user');

    expect(wrapped.kind).toBe(Kind.NotFound);
  });

  it('preserves fields and details', () => {
    const original = invalid('not valid', issues, {
      details: { requestId: '01a024c7-d2d6-7e71-8c87-e344e27ef844' },
    });
    const wrapped = wrap(original, 'register user');

    expect(wrapped.fields).toEqual(issues);
    expect(wrapped.details['requestId']).toBe(
      '01a024c7-d2d6-7e71-8c87-e344e27ef844',
    );
  });

  it('reads outside-in, which is the order that helps in a log', () => {
    const inner = unavailable('connection refused');
    const middle = wrap(inner, 'query user by id');
    const outer = wrap(middle, 'load user');

    expect(outer.message).toBe(
      'load user: query user by id: connection refused',
    );
  });

  it('chains the cause rather than replacing it', () => {
    const inner = unavailable('connection refused');
    const wrapped = wrap(inner, 'query user by id');

    expect(wrapped.cause).toBe(inner);
  });

  it('classifies an unclassified value as internal', () => {
    const wrapped = wrap(new TypeError('x is not a function'), 'render page');

    expect(wrapped.kind).toBe(Kind.Internal);
    expect(wrapped.message).toBe('render page: x is not a function');
  });

  it('survives a thrown non-Error, which happens more than anyone admits', () => {
    const wrapped = wrap('database exploded', 'load user');

    expect(wrapped.kind).toBe(Kind.Internal);
    expect(wrapped.message).toBe('load user: database exploded');
  });
});

describe('chain', () => {
  it('returns the causes outermost first', () => {
    const inner = unavailable('connection refused');
    const middle = wrap(inner, 'query user by id');
    const outer = wrap(middle, 'load user');

    expect(chain(outer)).toEqual([outer, middle, inner]);
  });

  it('is a single entry when nothing was wrapped', () => {
    const error = notFound('gone');

    expect(chain(error)).toEqual([error]);
  });

  it('terminates on a cycle instead of hanging the process', () => {
    // Nothing should build one. Something eventually will, and a rule that
    // hangs the logger is worse than the bug it was printing.
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    Object.defineProperty(first, 'cause', { value: second });

    expect(chain(second)).toEqual([second, first]);
  });

  it('finds the thing that actually went wrong', () => {
    const inner = unavailable('connection refused');
    const outer = wrap(wrap(inner, 'query user by id'), 'load user');

    expect(rootCause(outer)).toBe(inner);
  });
});
