import { describe as suite, expect, expectTypeOf, it } from 'vitest';
import { type AppError, isAppError, Kind } from '../errors/index.js';
import {
  assertDefined,
  assertNever,
  invariant,
  must,
  unreachable,
} from './index.js';

/** Catch and return, so a message can be asserted on without a matcher dance. */
function thrownBy(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to throw, and it did not');
}

suite('invariant', () => {
  it('does nothing when the condition holds', () => {
    expect(() => {
      invariant(true, 'always');
    }).not.toThrow();
  });

  it('throws Internal, because a violated invariant is a bug', () => {
    const error = thrownBy(() => {
      invariant(false, 'a user always has an email');
    });

    expect(error.kind).toBe(Kind.Internal);
    expect(error.message).toBe(
      'invariant violated: a user always has an email',
    );
  });

  it('treats every falsy value as a violation', () => {
    for (const value of [0, -0, '', Number.NaN, null, undefined, false, 0n]) {
      expect(() => {
        invariant(value, 'falsy');
      }).toThrow();
    }
  });

  it('narrows for everything after the call', () => {
    const value = 'ada@example.com' as string | undefined;

    invariant(value !== undefined, 'email was parsed');

    // No cast, and no non-null assertion: the narrowing is the return value.
    expectTypeOf(value).toEqualTypeOf<string>();
    expect(value.length).toBeGreaterThan(0);
  });
});

suite('assertDefined', () => {
  it('accepts falsy values that are nonetheless present', () => {
    // The classic bug this exists to avoid: a truthiness check rejects 0 and
    // the empty string, which are perfectly good values.
    expect(() => {
      assertDefined(0, 'count');
    }).not.toThrow();
    expect(() => {
      assertDefined('', 'name');
    }).not.toThrow();
    expect(() => {
      assertDefined(false, 'flag');
    }).not.toThrow();
  });

  it('rejects null and undefined, naming which it got', () => {
    expect(
      thrownBy(() => {
        assertDefined(null, 'the tenant on provenance');
      }).message,
    ).toBe('expected the tenant on provenance to be defined, got null');

    expect(
      thrownBy(() => {
        assertDefined(undefined, 'the first row');
      }).message,
    ).toBe('expected the first row to be defined, got undefined');
  });

  it('narrows away null and undefined', () => {
    const value = 'ada@example.com' as string | null | undefined;

    assertDefined(value, 'email');

    expectTypeOf(value).toEqualTypeOf<string>();
  });
});

suite('must', () => {
  it('returns the value, so it fits where a statement will not', () => {
    const rows = ['first', 'second'];

    // Under noUncheckedIndexedAccess, rows.at(0) is `string | undefined`.
    const first = must(rows.at(0), 'first row');

    expectTypeOf(first).toEqualTypeOf<string>();
    expect(first).toBe('first');
  });

  it('explains itself when it fires, unlike a non-null assertion', () => {
    const rows: string[] = [];

    expect(thrownBy(() => must(rows.at(0), 'first row')).message).toBe(
      'expected first row to be defined, got undefined',
    );
  });
});

suite('assertNever', () => {
  type Shape =
    | { readonly kind: 'circle'; readonly radius: number }
    | { readonly kind: 'square'; readonly side: number };

  const area = (shape: Shape): number => {
    switch (shape.kind) {
      case 'circle':
        return Math.PI * shape.radius ** 2;
      case 'square':
        return shape.side ** 2;
      default:
        // Adding a member to Shape makes this line a compile error, which is
        // the entire value: the failure surfaces before anything ships.
        return assertNever(shape, 'Shape');
    }
  };

  it('is unreachable while the union is fully handled', () => {
    expect(area({ kind: 'square', side: 4 })).toBe(16);
  });

  it('names the case that was missed, not just that one was', () => {
    // Forced past the compiler the way a decoded payload arrives at runtime.
    const rogue = { kind: 'triangle', base: 3 } as unknown as Shape;

    const error = thrownBy(() => area(rogue));

    expect(error.kind).toBe(Kind.Internal);
    expect(error.message).toBe('unhandled Shape: [object]');
  });

  it('renders a primitive discriminant, which is the usual case', () => {
    const error = thrownBy(() => assertNever('sepia' as never, 'Kind'));

    expect(error.message).toBe('unhandled Kind: "sepia"');
  });
});

suite('message rendering', () => {
  it('quotes strings and truncates long ones', () => {
    const long = 'x'.repeat(100);

    expect(thrownBy(() => assertNever(long as never)).message).toBe(
      `unhandled value: "${'x'.repeat(64)}…"`,
    );
  });

  it('renders other primitives plainly', () => {
    expect(thrownBy(() => assertNever(7 as never)).message).toBe(
      'unhandled value: 7',
    );
    expect(
      thrownBy(() => assertNever(9007199254740993n as never)).message,
    ).toBe('unhandled value: 9007199254740993');
  });

  it('describes structural values by type, never by contents', () => {
    // An object could be a whole aggregate, or hold a secret, and an assertion
    // message ends up in a log.
    const user = { email: 'ada@example.com', apiKey: 'sk_live_51H8yQwErTyUi' };

    const error = thrownBy(() => assertNever(user as never, 'User'));

    expect(error.message).toBe('unhandled User: [object]');
    expect(error.message).not.toContain('sk_live');
    expect(error.message).not.toContain('ada@example.com');
  });
});

suite('unreachable', () => {
  it('throws Internal with the reason', () => {
    const error = thrownBy(() => unreachable('the relay loop exited'));

    expect(error.kind).toBe(Kind.Internal);
    expect(error.message).toBe('unreachable: the relay loop exited');
  });
});
