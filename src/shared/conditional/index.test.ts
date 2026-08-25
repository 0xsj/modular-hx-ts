import { describe, expect, it } from 'vitest';
import { millis, systemClock } from '../clock/index.js';
import {
  type Exchange,
  type Handler,
  type Request,
  type Response,
  json,
  text,
} from '../edge/index.js';
import { chain } from '../httpx/index.js';
import { fakeIds } from '../id/index.js';
import { makeOrigins } from '../provenance/index.js';
import { isErr, unwrap } from '../result/index.js';
import { memoryTelemetry } from '../telemetry/index.js';
import {
  type ETag,
  type Validator,
  type Validators,
  conditional,
  evaluate,
  formatETag,
  parseETag,
  parseHttpDate,
  parseTagList,
  strongETag,
  strongEquals,
  strongTagFor,
  strongTagForBytes,
  weakETag,
  weakEquals,
} from './index.js';

// --- the grammar, RFC 9110 §8.8.3 ------------------------------------------

describe('entity-tag syntax', () => {
  it('parses an opaque tag', () => {
    expect(unwrap(parseETag('"xyzzy"'))).toEqual({
      opaque: 'xyzzy',
      weak: false,
    });
  });

  it('parses the weak prefix', () => {
    expect(unwrap(parseETag('W/"xyzzy"'))).toEqual({
      opaque: 'xyzzy',
      weak: true,
    });
  });

  it('treats `W/` as case-SENSITIVE, because the ABNF says %s', () => {
    // `w/"x"` is not a weak tag; it is not a tag at all. Accepting it would
    // silently change which comparison applies to the request.
    expect(isErr(parseETag('w/"xyzzy"'))).toBe(true);
  });

  it('accepts an empty opaque tag, which is legal', () => {
    expect(unwrap(parseETag('""')).opaque).toBe('');
  });

  it('refuses an unquoted tag', () => {
    expect(isErr(parseETag('xyzzy'))).toBe(true);
  });

  it('refuses a tag carrying a quote or a control character', () => {
    // `etagc` excludes DQUOTE and the control range, which is what stops a tag
    // from smuggling a header separator or a newline into a response.
    expect(isErr(parseETag('"a"b"'))).toBe(true);
    expect(isErr(parseETag('"a\nb"'))).toBe(true);
  });

  it('round-trips through formatting', () => {
    for (const field of ['"xyzzy"', 'W/"xyzzy"', '""']) {
      expect(formatETag(unwrap(parseETag(field)))).toBe(field);
    }
  });
});

describe('entity-tag lists', () => {
  it('parses several', () => {
    const list = unwrap(parseTagList('"a", W/"b" , "c"'));

    expect(list.kind).toBe('tags');
    expect(list.kind === 'tags' && list.tags).toEqual([
      { opaque: 'a', weak: false },
      { opaque: 'b', weak: true },
      { opaque: 'c', weak: false },
    ]);
  });

  it('parses the wildcard', () => {
    expect(unwrap(parseTagList('*')).kind).toBe('wildcard');
  });

  it('keeps a COMMA inside a tag, because %x2C is a legal etagc', () => {
    // **`split(',')` gets this wrong**, and it only shows against a foreign
    // tag: the tags this repository emits are hex digests, so nothing it
    // produces would ever surface the bug. Split naively, `"a,b"` becomes two
    // malformed entries, the whole `If-Match` is rejected, and a caller who did
    // nothing wrong gets a 412.
    const list = unwrap(parseTagList('"a,b", "c"'));

    expect(list.kind === 'tags' && list.tags.map((t) => t.opaque)).toEqual([
      'a,b',
      'c',
    ]);
  });

  it('refuses an unterminated tag rather than guessing', () => {
    expect(isErr(parseTagList('"a'))).toBe(true);
  });

  it('refuses an empty list', () => {
    expect(isErr(parseTagList(''))).toBe(true);
    expect(isErr(parseTagList(' , '))).toBe(true);
  });
});

// --- the two comparisons ---------------------------------------------------

describe('strong and weak comparison are NOT interchangeable', () => {
  // **Implementing one and using it for both is the standard error here**, and
  // it passes casual testing because the two agree whenever no weak tag is
  // involved. These cases are written as a table so the disagreement is the
  // thing being asserted rather than a side effect.
  const cases: readonly {
    a: ETag;
    b: ETag;
    strong: boolean;
    weak: boolean;
  }[] = [
    { a: strongETag('1'), b: strongETag('1'), strong: true, weak: true },
    { a: strongETag('1'), b: strongETag('2'), strong: false, weak: false },
    // The three rows that matter. RFC 9110 §8.8.3.2's own example table.
    { a: weakETag('1'), b: weakETag('1'), strong: false, weak: true },
    { a: weakETag('1'), b: strongETag('1'), strong: false, weak: true },
    { a: strongETag('1'), b: weakETag('1'), strong: false, weak: true },
    { a: weakETag('1'), b: weakETag('2'), strong: false, weak: false },
  ];

  it('agrees on every pair of strong tags', () => {
    for (const { a, b, strong, weak } of cases.slice(0, 2)) {
      expect(strongEquals(a, b)).toBe(strong);
      expect(weakEquals(a, b)).toBe(weak);
      expect(strongEquals(a, b)).toBe(weakEquals(a, b));
    }
  });

  it('DISAGREES wherever a weak tag is involved and the opaque parts match', () => {
    // This is the whole reason there are two functions. One implementation
    // used for both is correct on the rows above and wrong on these.
    for (const { a, b } of cases.slice(2, 5)) {
      expect(strongEquals(a, b)).toBe(false);
      expect(weakEquals(a, b)).toBe(true);
      expect(strongEquals(a, b)).not.toBe(weakEquals(a, b));
    }
  });

  it('refuses a weak tag against ITSELF under strong comparison', () => {
    // The one that looks like a bug until you know what weak means: `W/"1"`
    // may describe two representations that are semantically equal and byte
    // different, and `If-Match` guards a write.
    const tag = weakETag('1');

    expect(strongEquals(tag, tag)).toBe(false);
    expect(weakEquals(tag, tag)).toBe(true);
  });

  it('matches the full §8.8.3.2 table', () => {
    for (const { a, b, strong, weak } of cases) {
      expect(
        strongEquals(a, b),
        `strong ${formatETag(a)}/${formatETag(b)}`,
      ).toBe(strong);
      expect(weakEquals(a, b), `weak ${formatETag(a)}/${formatETag(b)}`).toBe(
        weak,
      );
    }
  });
});

// --- deriving a strong tag -------------------------------------------------

describe('the ETag is strong, and forced rather than chosen', () => {
  it('is never weak', () => {
    // **A weak validator never matches under strong comparison**, so a weak
    // tag makes case 29's `If-Match` return 412 forever — passing the case for
    // the wrong reason, which is worse than failing it, because nothing would
    // ever surface the mistake.
    expect(unwrap(strongTagFor('application/json', { a: 1 })).weak).toBe(false);
  });

  it('is stable across key order, because the serialization is canonical', () => {
    // Strong means byte-identical representations share one validator, which is
    // only achievable with a canonical form. This repository has one already —
    // RFC 8785, built for event digests — so a strong ETag is available here
    // where most codebases can only manage a weak one.
    const a = unwrap(strongTagFor('application/json', { b: 2, a: 1 }));
    const b = unwrap(strongTagFor('application/json', { a: 1, b: 2 }));

    expect(a).toEqual(b);
    expect(strongEquals(a, b)).toBe(true);
  });

  it('differs when the representation differs', () => {
    const a = unwrap(strongTagFor('application/json', { a: 1 }));
    const b = unwrap(strongTagFor('application/json', { a: 2 }));

    expect(strongEquals(a, b)).toBe(false);
  });

  it('does NOT share a tag between two variants of one resource', () => {
    // **A tag identifies a representation, not an entity.** A caller holding
    // the JSON would otherwise be told 304 for the CSV.
    const asJson = unwrap(strongTagFor('application/json', { a: 1 }));
    const asCsv = unwrap(strongTagFor('text/csv', { a: 1 }));

    expect(weakEquals(asJson, asCsv)).toBe(false);
  });

  it('cannot be forged by moving bytes between the variant and the body', () => {
    // Without a separator, variant `ab` over `c` and variant `a` over `bc` are
    // the same tag.
    const encode = (value: string): Uint8Array =>
      new TextEncoder().encode(value);

    expect(
      weakEquals(
        strongTagForBytes('ab', encode('c')),
        strongTagForBytes('a', encode('bc')),
      ),
    ).toBe(false);
  });

  it('is a legal opaque-tag, so it survives a round trip', () => {
    const tag = unwrap(strongTagFor('application/json', { a: 1 }));

    expect(unwrap(parseETag(formatETag(tag)))).toEqual(tag);
  });

  it('carries the whole digest rather than a prefix', () => {
    // A shortened digest is a validator with a birthday bound nobody wrote
    // down.
    const tag = unwrap(strongTagFor('application/json', { a: 1 }));

    expect(tag.opaque).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses a representation canonical JSON cannot express', () => {
    expect(isErr(strongTagFor('application/json', { bad: 1n }))).toBe(true);
  });
});

// --- §13.2.2 ---------------------------------------------------------------

const CURRENT = strongETag('v1');
const validator: Validator = {
  etag: CURRENT,
  lastModified: new Date('2026-08-23T12:00:00.000Z'),
};

const AT = 'Sun, 23 Aug 2026 12:00:00 GMT';
const BEFORE = 'Sun, 23 Aug 2026 11:00:00 GMT';
const AFTER = 'Sun, 23 Aug 2026 13:00:00 GMT';

describe('If-Match — strong comparison, case 29', () => {
  it('proceeds when the tag matches', () => {
    expect(evaluate('PUT', { ifMatch: '"v1"' }, validator).kind).toBe(
      'proceed',
    );
  });

  it('is 412 when the tag is stale', () => {
    // Conformance case 29.
    expect(evaluate('PUT', { ifMatch: '"v0"' }, validator).kind).toBe(
      'precondition-failed',
    );
  });

  it('is 412 for a WEAK tag, even one that names the current representation', () => {
    // The forcing argument, as behaviour: `If-Match` uses strong comparison, so
    // a weak validator can never satisfy it. A server emitting `W/"v1"` would
    // 412 every write forever while looking correct.
    expect(evaluate('PUT', { ifMatch: 'W/"v1"' }, validator).kind).toBe(
      'precondition-failed',
    );
  });

  it('matches any tag in the list', () => {
    expect(evaluate('PUT', { ifMatch: '"v0", "v1"' }, validator).kind).toBe(
      'proceed',
    );
  });

  it('treats `*` as "any current representation"', () => {
    expect(evaluate('PUT', { ifMatch: '*' }, validator).kind).toBe('proceed');
    // Which makes `If-Match: *` a replace-only guard: nothing to replace.
    expect(evaluate('PUT', { ifMatch: '*' }, undefined).kind).toBe(
      'precondition-failed',
    );
  });

  it('is 412 on a malformed list rather than ignoring it', () => {
    // Unlike a malformed date, this cannot be ignored: the caller asked for a
    // guard on a write and we cannot evaluate it.
    expect(evaluate('PUT', { ifMatch: 'garbage' }, validator).kind).toBe(
      'precondition-failed',
    );
  });
});

describe('If-None-Match — weak comparison, case 30', () => {
  it('is 304 on GET when the tag matches', () => {
    expect(evaluate('GET', { ifNoneMatch: '"v1"' }, validator).kind).toBe(
      'not-modified',
    );
  });

  it('is 304 on HEAD as well', () => {
    expect(evaluate('HEAD', { ifNoneMatch: '"v1"' }, validator).kind).toBe(
      'not-modified',
    );
  });

  it('is 412 on a MUTATING method — the branch a browser never exercises', () => {
    // A failed `If-None-Match` on a PUT means *create only, do not replace*.
    // Answering 304 would tell a client its write was skipped for caching
    // reasons, which is the version reliably wrong in the wild.
    for (const method of ['PUT', 'POST', 'PATCH', 'DELETE']) {
      expect(
        evaluate(method, { ifNoneMatch: '"v1"' }, validator).kind,
        method,
      ).toBe('precondition-failed');
    }
  });

  it('matches a WEAK tag, unlike If-Match', () => {
    // The two headers, the same tag, opposite answers. This is the pair that
    // makes one shared comparison function visibly wrong.
    expect(evaluate('GET', { ifNoneMatch: 'W/"v1"' }, validator).kind).toBe(
      'not-modified',
    );
    expect(evaluate('PUT', { ifMatch: 'W/"v1"' }, validator).kind).toBe(
      'precondition-failed',
    );
  });

  it('proceeds when nothing matches', () => {
    expect(evaluate('GET', { ifNoneMatch: '"v0"' }, validator).kind).toBe(
      'proceed',
    );
  });

  it('treats `*` as create-only on a mutating method', () => {
    expect(evaluate('PUT', { ifNoneMatch: '*' }, validator).kind).toBe(
      'precondition-failed',
    );
    expect(evaluate('PUT', { ifNoneMatch: '*' }, undefined).kind).toBe(
      'proceed',
    );
  });
});

describe('the date preconditions', () => {
  it('is 412 when If-Unmodified-Since predates the last change', () => {
    expect(evaluate('PUT', { ifUnmodifiedSince: BEFORE }, validator).kind).toBe(
      'precondition-failed',
    );
  });

  it('proceeds when it does not', () => {
    expect(evaluate('PUT', { ifUnmodifiedSince: AFTER }, validator).kind).toBe(
      'proceed',
    );
  });

  it('is 304 when If-Modified-Since is at or after the last change', () => {
    expect(evaluate('GET', { ifModifiedSince: AT }, validator).kind).toBe(
      'not-modified',
    );
  });

  it('compares at SECOND precision, because HTTP-date has no more', () => {
    // A sub-second write would otherwise look newer than any header that could
    // describe it, and every conditional GET would transfer.
    const justAfter: Validator = {
      etag: CURRENT,
      lastModified: new Date('2026-08-23T12:00:00.750Z'),
    };

    expect(evaluate('GET', { ifModifiedSince: AT }, justAfter).kind).toBe(
      'not-modified',
    );
  });

  it('IGNORES an unparseable date rather than failing — §13.1.3', () => {
    // A broken proxy that mangles a date must not turn every conditional GET
    // into a 412.
    expect(
      evaluate('GET', { ifModifiedSince: 'not a date' }, validator).kind,
    ).toBe('proceed');
    expect(
      evaluate('PUT', { ifUnmodifiedSince: 'not a date' }, validator).kind,
    ).toBe('proceed');
  });

  it('ignores If-Modified-Since on a mutating method — §13.1.3', () => {
    expect(evaluate('PUT', { ifModifiedSince: AT }, validator).kind).toBe(
      'proceed',
    );
  });

  it('parses an HTTP-date and refuses a non-date', () => {
    expect(parseHttpDate(AT)?.toISOString()).toBe('2026-08-23T12:00:00.000Z');
    expect(parseHttpDate('nonsense')).toBeUndefined();
  });
});

describe('precedence — §13.2.2, and the order is normative', () => {
  it('consults If-Unmodified-Since ONLY when If-Match is absent', () => {
    // Not "only when If-Match passed". A request carrying a satisfied
    // `If-Match` and a violated `If-Unmodified-Since` proceeds, and a server
    // that evaluated both would 412 it.
    expect(
      evaluate('PUT', { ifMatch: '"v1"', ifUnmodifiedSince: BEFORE }, validator)
        .kind,
    ).toBe('proceed');
  });

  it('lets a failed If-Match win over everything after it', () => {
    expect(
      evaluate(
        'GET',
        { ifMatch: '"v0"', ifNoneMatch: '"v0"', ifModifiedSince: AT },
        validator,
      ).kind,
    ).toBe('precondition-failed');
  });

  it('consults If-Modified-Since ONLY when If-None-Match is absent', () => {
    // A satisfied `If-None-Match` proceeds even though `If-Modified-Since`
    // alone would have produced a 304.
    expect(
      evaluate('GET', { ifNoneMatch: '"v0"', ifModifiedSince: AT }, validator)
        .kind,
    ).toBe('proceed');
  });

  it('reaches If-None-Match after a satisfied If-Match', () => {
    expect(
      evaluate('GET', { ifMatch: '"v1"', ifNoneMatch: '"v1"' }, validator).kind,
    ).toBe('not-modified');
  });
});

describe('If-Range — step 5', () => {
  const ranged = { range: 'bytes=0-99' };

  it('keeps the range when the strong tag still matches', () => {
    const outcome = evaluate('GET', { ...ranged, ifRange: '"v1"' }, validator);

    expect(outcome.kind === 'proceed' && outcome.rangeApplicable).toBe(true);
  });

  it('drops the range when the representation has changed', () => {
    const outcome = evaluate('GET', { ...ranged, ifRange: '"v0"' }, validator);

    expect(outcome.kind === 'proceed' && outcome.rangeApplicable).toBe(false);
  });

  it('never accepts a WEAK tag, because bytes get spliced', () => {
    // A partial response is stitched into a cached representation, so
    // *semantically equivalent* is not good enough: splicing bytes from one
    // representation into another produces a document that never existed.
    const outcome = evaluate(
      'GET',
      { ...ranged, ifRange: 'W/"v1"' },
      validator,
    );

    expect(outcome.kind === 'proceed' && outcome.rangeApplicable).toBe(false);
  });

  it('accepts the date form only on an exact match', () => {
    expect(evaluate('GET', { ...ranged, ifRange: AT }, validator)).toEqual({
      kind: 'proceed',
      rangeApplicable: true,
    });
    expect(evaluate('GET', { ...ranged, ifRange: BEFORE }, validator)).toEqual({
      kind: 'proceed',
      rangeApplicable: false,
    });
  });

  it('is ignored without a Range', () => {
    expect(evaluate('GET', { ifRange: '"v0"' }, validator)).toEqual({
      kind: 'proceed',
      rangeApplicable: false,
    });
  });
});

// --- the middleware, through the real chain --------------------------------

const clock = systemClock();

function callable(handler: Handler, validators: Validators) {
  const built = chain(
    {
      clock,
      origins: makeOrigins(fakeIds(clock)),
      telemetry: memoryTelemetry(clock),
      conditional: conditional({ validators }),
    },
    handler,
  );

  return (over: Partial<Request> = {}): Promise<Response> => {
    const request: Request = {
      method: 'GET',
      path: '/things/1',
      query: {},
      headers: {},
      peer: '127.0.0.1',
      body: () => Promise.resolve(''),
      ...over,
    };
    return built({
      request,
      responseHeaders: {},
      remaining: () => millis(30_000),
    } as Exchange);
  };
}

/**
 * A test double, and it lives here rather than in `src` on purpose.
 *
 * **`Validators` deliberately has no implementation in this repository.** The
 * first aggregate supplies one; shipping a plausible-looking default would
 * encode three decisions the domain has not made — versioning, which fields are
 * part of the representation, and how a collection tags itself.
 */
const supplying =
  (value: Validator | undefined): Validators =>
  () =>
    value;

const ok: Handler = () => Promise.resolve(json(200, { id: 1 }));

describe('case 30 — GET returns an ETag, If-None-Match returns 304 and no body', () => {
  it('puts the validator on a GET', async () => {
    const response = await callable(ok, supplying(validator))();

    expect(response.status).toBe(200);
    expect(response.headers['etag']).toBe('"v1"');
  });

  it('answers 304 with no body', async () => {
    const response = await callable(
      ok,
      supplying(validator),
    )({ headers: { 'if-none-match': '"v1"' } });

    expect(response.status).toBe(304);
    expect(response.body).toBe('');
  });

  it('carries the validator on the 304, so a cache can update its metadata', async () => {
    // §15.4.5: a 304 sends the header fields that would have been sent in a
    // 200. Without the tag, a cache holding a stale `Last-Modified` has nothing
    // to refresh from.
    const response = await callable(
      ok,
      supplying(validator),
    )({ headers: { 'if-none-match': '"v1"' } });

    expect(response.headers['etag']).toBe('"v1"');
  });

  it('never runs the handler for a 304', async () => {
    let calls = 0;
    const response = await callable(() => {
      calls += 1;
      return Promise.resolve(json(200, {}));
    }, supplying(validator))({ headers: { 'if-none-match': '"v1"' } });

    expect(response.status).toBe(304);
    expect(calls).toBe(0);
  });

  it('does not overwrite an ETag the handler set itself', async () => {
    // A handler that set one knows something this position does not.
    const response = await callable(
      () =>
        Promise.resolve({ status: 200, headers: { etag: '"own"' }, body: '' }),
      supplying(validator),
    )();

    expect(response.headers['etag']).toBe('"own"');
  });
});

describe('case 29 — a stale If-Match is 412, through the same mapper', () => {
  it('is an RFC 9457 problem body with a request id', async () => {
    // Position 9 is below the mapper at position 3 precisely so a 412 is built
    // by the same code as every other error.
    const response = await callable(
      ok,
      supplying(validator),
    )({ method: 'PUT', headers: { 'if-match': '"v0"' } });

    expect(response.status).toBe(412);
    expect(response.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(response.body)).toMatchObject({
      type: '/problems/precondition-failed',
      status: 412,
    });
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never runs the handler', async () => {
    let calls = 0;
    await callable(() => {
      calls += 1;
      return Promise.resolve(json(200, {}));
    }, supplying(validator))({
      method: 'PUT',
      headers: { 'if-match': '"v0"' },
    });

    expect(calls).toBe(0);
  });

  it('runs it when the precondition holds', async () => {
    const response = await callable(
      () => Promise.resolve(text(200, 'written')),
      supplying(validator),
    )({ method: 'PUT', headers: { 'if-match': '"v1"' } });

    expect(response.status).toBe(200);
    expect(response.body).toBe('written');
  });
});

describe('what the middleware leaves alone', () => {
  it('does not ask for a validator on an unconditional write', async () => {
    // Asking would put a read in front of every write for nothing.
    let asked = 0;
    const counting: Validators = () => {
      asked += 1;
      return validator;
    };

    await callable(ok, counting)({ method: 'POST' });

    expect(asked).toBe(0);
  });

  it('does ask on a GET, because case 30 needs the tag on the way out', async () => {
    let asked = 0;
    const counting: Validators = () => {
      asked += 1;
      return validator;
    };

    await callable(ok, counting)();

    expect(asked).toBe(1);
  });

  it('serves normally when there is no validator to be had', async () => {
    // Nothing has to implement `Validators` for the chain to work: a resource
    // with no validator is simply unconditional.
    const response = await callable(ok, supplying(undefined))();

    expect(response.status).toBe(200);
    expect(response.headers['etag']).toBeUndefined();
  });

  it('is 412 for If-Match against a resource that does not exist', async () => {
    const response = await callable(
      ok,
      supplying(undefined),
    )({ method: 'PUT', headers: { 'if-match': '"v1"' } });

    expect(response.status).toBe(412);
  });
});

describe('a tag derived here survives a real round trip', () => {
  it('is emitted, echoed back, and answered 304', async () => {
    // End to end: `strongTagFor` produces it, the response carries it, and the
    // same string in `If-None-Match` matches it. A tag that is not a legal
    // opaque-tag would break here rather than in a unit test.
    const body = { id: 1, name: 'thing' };
    const tag = unwrap(strongTagFor('application/json', body));
    const call = callable(
      () => Promise.resolve(json(200, body)),
      supplying({ etag: tag }),
    );

    const first = await call();
    const field = first.headers['etag'];

    expect(field).toBe(formatETag(tag));
    // And the field re-parses to the tag it was built from, which is the part
    // a unit test on `formatETag` alone cannot show: it went through a header.
    expect(unwrap(parseETag(field ?? ''))).toEqual(tag);

    const second = await call({ headers: { 'if-none-match': field ?? '' } });

    expect(second.status).toBe(304);
  });
});
