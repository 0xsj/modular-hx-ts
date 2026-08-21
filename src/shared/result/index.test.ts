import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  isAppError,
  Kind,
  kindOf,
  notFound,
  unavailable,
} from '../errors/index.js';
import {
  all,
  andThen,
  attempt,
  attemptAsync,
  err,
  isErr,
  isOk,
  map,
  mapError,
  match,
  ok,
  unwrap,
  unwrapOr,
  unwrapOrElse,
  type Result,
} from './index.js';

interface User {
  readonly id: string;
  readonly email: string;
}

const ada: User = {
  id: '01a024c7-d2d6-7e71-8c87-e344e27ef844',
  email: 'ada@example.com',
};

describe('ok and err', () => {
  it('carries a value under a discriminant', () => {
    const result = ok(ada);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual(ada);
  });

  it('carries a failure under the same discriminant', () => {
    const error = notFound('no user with that id');
    const result = err(error);

    expect(result.ok).toBe(false);
    expect(result.error).toBe(error);
  });

  it('survives JSON, which is the reason it is not a class', () => {
    // A class with methods loses them here, and a Result that cannot cross a
    // process boundary is a Result that cannot go in a job payload.
    const round = JSON.parse(JSON.stringify(ok(ada))) as Result<User>;

    expect(round).toEqual({ ok: true, value: ada });
    expect(isOk(round)).toBe(true);
  });

  it('narrows without a method call or an import', () => {
    // Behind a function boundary on purpose: assigned to a const, TypeScript
    // narrows at the declaration and the else branch is provably dead.
    const load = (): Result<User> => ok(ada);
    const result = load();

    if (result.ok) {
      expect(result.value.email).toBe('ada@example.com');
    } else {
      expect.unreachable('constructed as ok');
    }

    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
  });
});

describe('map and mapError', () => {
  it('changes the value', () => {
    const result = map(ok(ada), (user) => user.email);

    expect(unwrap(result)).toBe('ada@example.com');
  });

  it('leaves a failure alone, and does not run the function', () => {
    const fn = vi.fn();
    const failure: Result<User> = err(notFound('gone'));

    const result = map(failure, fn);

    expect(fn).not.toHaveBeenCalled();
    expect(isErr(result)).toBe(true);
  });

  it('changes the failure', () => {
    const failure: Result<User> = err(notFound('no row'));

    const result = mapError(
      failure,
      (error) => new AppError(Kind.Internal, `unexpected: ${error.message}`),
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe(Kind.Internal);
      expect(result.error.message).toBe('unexpected: no row');
    }
  });

  it('leaves a value alone, and does not run the function', () => {
    const fn = vi.fn();

    const result = mapError(ok(ada), fn);

    expect(fn).not.toHaveBeenCalled();
    expect(unwrap(result)).toEqual(ada);
  });
});

describe('andThen', () => {
  const emailOf = (user: User): Result<string> =>
    user.email.includes('@') ? ok(user.email) : err(notFound('no email'));

  it('chains a step that can itself fail', () => {
    expect(unwrap(andThen(ok(ada), emailOf))).toBe('ada@example.com');
  });

  it('short-circuits on the first failure', () => {
    // The whole point: step three must not run after step two failed.
    const second = vi.fn(emailOf);
    const failure: Result<User> = err(unavailable('connection refused'));

    const result = andThen(failure, second);

    expect(second).not.toHaveBeenCalled();
    expect(kindOf(isErr(result) ? result.error : undefined)).toBe(
      Kind.Unavailable,
    );
  });
});

describe('match', () => {
  it('handles both sides exhaustively', () => {
    const describe_ = (result: Result<User>): string =>
      match(result, {
        ok: (user) => `found ${user.email}`,
        err: (error) => `failed: ${error.message}`,
      });

    expect(describe_(ok(ada))).toBe('found ada@example.com');
    expect(describe_(err(notFound('gone')))).toBe('failed: gone');
  });
});

describe('unwrapping', () => {
  it('returns the value, or the fallback', () => {
    expect(unwrapOr(ok(ada), { id: '', email: '' })).toEqual(ada);
    expect(unwrapOr<User, AppError>(err(notFound('gone')), ada)).toEqual(ada);
  });

  it('computes the fallback only when it is needed', () => {
    const fallback = vi.fn(() => ada);

    expect(unwrapOrElse(ok(ada), fallback)).toEqual(ada);
    expect(fallback).not.toHaveBeenCalled();

    expect(
      unwrapOrElse<User, AppError>(err(notFound('gone')), fallback),
    ).toEqual(ada);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('throws the failure as it was, when it is already an Error', () => {
    const error = unavailable('connection refused');

    expect(() => unwrap(err(error))).toThrow(error);
  });

  it('classifies a non-Error failure rather than throwing a bare value', () => {
    // A thrown string loses the stack and breaks every catch upstream that
    // expected an Error.
    let thrown: unknown;
    try {
      unwrap(err('database exploded'));
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    expect((thrown as AppError).kind).toBe(Kind.Internal);
    expect((thrown as AppError).message).toBe('unwrap: database exploded');
  });
});

describe('all', () => {
  it('collects every value, in order', () => {
    const results = [ok(1), ok(2), ok(3)];

    expect(unwrap(all(results))).toEqual([1, 2, 3]);
  });

  it('is ok for an empty list', () => {
    expect(unwrap(all<number, AppError>([]))).toEqual([]);
  });

  it('returns the FIRST failure, not the last', () => {
    // Steps, not validation: reporting the last failure would describe work
    // that should never have run.
    const first = notFound('step two: gone');
    const second = unavailable('step three: connection refused');
    const results: Result<number>[] = [ok(1), err(first), err(second)];

    const result = all(results);

    expect(isErr(result) && result.error).toBe(first);
  });
});

describe('attempt', () => {
  it('turns a return into a value', () => {
    expect(
      unwrap(attempt(() => JSON.parse('{"a":1}') as unknown, 'parse config')),
    ).toEqual({ a: 1 });
  });

  it('turns a throw into a classified, located failure', () => {
    const result = attempt(
      () => JSON.parse('not json') as unknown,
      'parse config',
    );

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe(Kind.Internal);
      expect(result.error.message).toMatch(/^parse config: /);
      expect(result.error.cause).toBeInstanceOf(SyntaxError);
    }
  });
});

describe('attemptAsync', () => {
  it('turns a resolution into a value', async () => {
    const result = await attemptAsync(() => Promise.resolve(ada), 'load user');

    expect(unwrap(result)).toEqual(ada);
  });

  it('turns a rejection into a classified, located failure', async () => {
    const cause = unavailable('connection refused');
    const result = await attemptAsync(() => Promise.reject(cause), 'load user');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      // The kind survives the boundary: wrap preserves it.
      expect(result.error.kind).toBe(Kind.Unavailable);
      expect(result.error.message).toBe('load user: connection refused');
    }
  });

  it('survives a rejection with a non-Error, which drivers do', async () => {
    const result = await attemptAsync(
      // A bare-string rejection is the point of this test: real drivers do it,
      // and `attempt` has to survive them.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- deliberate
      () => Promise.reject('ECONNREFUSED'),
      'load user',
    );

    expect(isErr(result) && result.error.kind).toBe(Kind.Internal);
  });
});
