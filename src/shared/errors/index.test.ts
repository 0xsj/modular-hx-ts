import { describe, expect, it } from 'vitest';
import {
  AppError,
  chain,
  conflict,
  forbidden,
  hasKind,
  invalid,
  isAppError,
  isKind,
  isRetryable,
  Kind,
  kindOf,
  notFound,
  rootCause,
  timeout,
  unavailable,
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
