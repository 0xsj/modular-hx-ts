import { describe, expect, expectTypeOf, it } from 'vitest';
import { isAppError, Kind } from '../errors/index.js';
import { isErr, isOk, unwrap } from '../result/index.js';
import { type Brand, defineBrand, unsafeBrand } from './index.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type UserId = Brand<string, 'UserId'>;
const UserId = defineBrand<string, 'UserId'>('UserId', (value) =>
  UUID.test(value),
);

type OrgId = Brand<string, 'OrgId'>;
const OrgId = defineBrand<string, 'OrgId'>('OrgId', (value) =>
  UUID.test(value),
);

type ApiKey = Brand<string, 'ApiKey'>;
const ApiKey = defineBrand<string, 'ApiKey'>(
  'ApiKey',
  (value) => value.startsWith('sk_') && value.length >= 20,
);

const ADA = '01a024c7-d2d6-7e71-8c87-e344e27ef844';

describe('nominal typing', () => {
  // Checked by `make typecheck`, not by the runtime run: expectTypeOf erases to
  // nothing, and its assertions fail as tsc errors over src/**.
  it('makes a brand usable anywhere its base type is', () => {
    expectTypeOf<UserId>().toExtend<string>();
  });

  it('does not let a plain string stand in for a brand', () => {
    expectTypeOf<string>().not.toExtend<UserId>();
  });

  it('does not let two brands over the same base mix', () => {
    // The entire point. Both are strings, both are UUIDs, and passing one where
    // the other is meant is the bug this module exists to prevent.
    expectTypeOf<OrgId>().not.toExtend<UserId>();
    expectTypeOf<UserId>().not.toExtend<OrgId>();
  });
});

describe('make', () => {
  it('constructs a value that passes the predicate', () => {
    const id = unwrap(UserId.make(ADA));

    expect(id).toBe(ADA);
  });

  it('refuses one that does not', () => {
    const result = UserId.make('not-a-uuid');

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.kind).toBe(Kind.Invalid);
      expect(result.error.message).toBe('not a valid UserId');
    }
  });

  it('never echoes the value it rejected', () => {
    // Brands wrap identifiers, and also tokens. A constructor that quotes its
    // input puts secrets in logs, and this module cannot redact.
    const result = ApiKey.make('sk_live_51H8yQwErTyUiOpAsDfGh');

    expect(isOk(result)).toBe(true);

    const rejected = ApiKey.make('sk_live_short');
    expect(isErr(rejected)).toBe(true);
    if (isErr(rejected)) {
      expect(rejected.error.message).toBe('not a valid ApiKey');
      expect(JSON.stringify(rejected.error.details)).not.toContain('sk_live');
    }
  });
});

describe('is', () => {
  it('narrows a value that satisfies the predicate', () => {
    const raw: string = ADA;

    if (UserId.is(raw)) {
      expectTypeOf(raw).toExtend<UserId>();
      expect(raw).toBe(ADA);
    } else {
      expect.unreachable('a valid uuid');
    }
  });

  it('rejects one that does not', () => {
    expect(UserId.is('')).toBe(false);
    expect(UserId.is('01a024c7d2d67e718c87e344e27ef844')).toBe(false);
  });
});

describe('expect', () => {
  it('returns the branded value for a known-good literal', () => {
    expect(UserId.expect(ADA)).toBe(ADA);
  });

  it('throws a typed error rather than a bare one', () => {
    let thrown: unknown;
    try {
      UserId.expect('not-a-uuid');
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    expect(isAppError(thrown) && thrown.kind).toBe(Kind.Invalid);
  });
});

describe('erasure', () => {
  it('is the base value at runtime, with nothing added', () => {
    const id = unwrap(UserId.make(ADA));

    expect(typeof id).toBe('string');
    // Object.keys on a string primitive lists character indices, so the useful
    // question is whether the tag symbol got attached. It never does: the tag
    // is `declare`d and has no runtime existence at all.
    expect(Object.getOwnPropertySymbols(Object(id))).toEqual([]);
    expect(JSON.stringify({ id })).toBe(`{"id":"${ADA}"}`);
  });

  it('compares and concatenates as its base type', () => {
    const id = unwrap(UserId.make(ADA));

    expect(id === ADA).toBe(true);
    expect(`user:${id}`).toBe(`user:${ADA}`);
    expect([ADA].includes(id)).toBe(true);
  });

  it('survives a round trip through JSON as a plain string', () => {
    const id = unwrap(UserId.make(ADA));
    const round = JSON.parse(JSON.stringify(id)) as string;

    // And has to be re-validated on the way back in — the tag did not survive,
    // because there was never anything there to survive.
    expect(round).toBe(ADA);
    expect(UserId.is(round)).toBe(true);
  });
});

describe('unsafeBrand', () => {
  it('skips the predicate entirely', () => {
    // Legitimate exactly once: rehydrating rows a store validated on the way
    // in. Named so a reviewer can grep for it and count the uses.
    const id = unsafeBrand<string, 'UserId'>('definitely-not-a-uuid');

    expectTypeOf(id).toExtend<UserId>();
    expect(UserId.is(id)).toBe(false);
  });
});

describe('name', () => {
  it('is exposed for messages and assertions', () => {
    expect(UserId.name).toBe('UserId');
    expect(OrgId.name).toBe('OrgId');
  });
});
