import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fakeClock, millis, seconds } from '../clock/index.js';
import { Carrier, makeOrigins } from '../provenance/index.js';
import { fakeIds } from '../id/index.js';
import { isErr, unwrap } from '../result/index.js';
import { memoryTelemetry } from '../telemetry/index.js';
import { BUCKETS, bucketOf, inCohort } from './cohort.js';
import { fileSource } from './file.js';
import { flagsContract, SEED } from './flagstest.js';
import { makeFlags } from './port.js';
import { isFlagKey, validate, type Flag } from './rule.js';
import { staticSource } from './static.js';

const clock = fakeClock();
const telemetry = memoryTelemetry(clock);

const build = (flags: readonly Flag[] = SEED) =>
  makeFlags({ source: staticSource(flags), telemetry });

describe('the static provider', () => {
  flagsContract(() => ({
    name: 'static',
    flags: () => Promise.resolve(build()),
  }));
});

describe('the file provider', () => {
  flagsContract(() => ({
    name: 'file',
    flags: async () => {
      const source = fileSource({
        read: () => Promise.resolve(JSON.stringify(SEED)),
        clock: fakeClock(),
      });
      await source.start();
      return makeFlags({ source, telemetry });
    },
  }));
});

describe('sticky percentage cohorts', () => {
  it('puts a subject in the same bucket every time', () => {
    // Sticky, or a rollout is a coin flip per request and a user sees the
    // feature appear and disappear.
    const first = bucketOf('checkout.new_flow', 'u_ada');

    for (let i = 0; i < 20; i++) {
      expect(bucketOf('checkout.new_flow', 'u_ada')).toBe(first);
    }
  });

  it('puts one subject in different buckets for different flags', () => {
    // The flag key comes **first** in the hashed string for exactly this: with
    // the subject first, every 10% rollout selects the same tenth of users and
    // a user unlucky once is unlucky forever.
    const a = bucketOf('checkout.new_flow', 'u_ada');
    const b = bucketOf('search.ranking', 'u_ada');

    expect(a).not.toBe(b);
  });

  it('stays inside the bucket space', () => {
    for (const subject of ['u_1', 'u_2', 'u_ada', 'x'.repeat(200), '']) {
      const bucket = bucketOf('a.b', subject);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(BUCKETS);
    }
  });

  it('buckets a subject containing a colon, because there is no rejection rule', () => {
    // Decision 0009. Under the old `":"` separator this was refused — and
    // `provenance.Actor.String()` is `"kind:id"`, so the most natural call site
    // was rejected on every request while `flags` failed closed and the flag
    // silently never evaluated for anybody.
    expect(bucketOf('checkout.new_flow', 'user:u-1')).toBe(9042);
    expect(bucketOf('a', 'b:c')).toBe(5118);
  });

  it('does not collide when a key and subject concatenate the same way', () => {
    // `("ab", "c")` and `("a", "b")` are both `"abc"` without a separator, so
    // this catches one dropped entirely.
    expect(bucketOf('ab', 'c')).not.toBe(bucketOf('a', 'b'));
  });

  it('does not let a character count reach the encoding', () => {
    // `'😀'.length` is 2 in TypeScript and 1 in Python and Go, so anything
    // counting characters disagrees on the astral case. The string is hashed as
    // UTF-8 bytes; no count is involved.
    expect(bucketOf('unicode.flag', '😀')).toBe(5601);
    expect(bucketOf('unicode.flag', 'é中')).toBe(6292);
  });

  describe('the boundaries, where modulus bugs live', () => {
    const subjects = Array.from({ length: 200 }, (_, i) => `u_${String(i)}`);

    it('excludes everybody at 0', () => {
      for (const subject of subjects) {
        expect(unwrap(inCohort('a.b', subject, 0))).toBe(false);
      }
    });

    it('includes everybody at 100', () => {
      for (const subject of subjects) {
        expect(unwrap(inCohort('a.b', subject, 100))).toBe(true);
      }
    });

    it('is roughly proportional in between', () => {
      // Not a distribution test — a sanity check that the modulus is not
      // collapsing the space. 200 subjects at 50% should land near half.
      const inside = subjects.filter((s) =>
        unwrap(inCohort('a.b', s, 50)),
      ).length;

      expect(inside).toBeGreaterThan(60);
      expect(inside).toBeLessThan(140);
    });

    it('is monotonic: a wider rollout never drops somebody', () => {
      // Raising a percentage must not remove anyone, or a rollout going from
      // 10% to 20% takes the feature away from somebody who had it.
      const subject = 'u_ada';
      let previous = false;

      for (let pct = 0; pct <= 100; pct += 5) {
        const now = unwrap(inCohort('a.b', subject, pct));
        if (previous) expect(now).toBe(true);
        previous = now;
      }
    });

    it('refuses a percentage outside 0-100', () => {
      expect(isErr(inCohort('a.b', 'u', -1))).toBe(true);
      expect(isErr(inCohort('a.b', 'u', 101))).toBe(true);
      expect(isErr(inCohort('a.b', 'u', Number.NaN))).toBe(true);
    });
  });

  it('excludes a subject-less scope rather than including it', () => {
    // An anonymous caller must not silently join every cohort.
    const rollout = build([
      {
        key: 'a.b',
        fallback: 'off',
        rules: [{ when: { percentage: 100 }, value: 'on' }],
      },
    ]);

    expect(rollout.enabled('a.b', {})).toBe(false);
    expect(rollout.enabled('a.b', { subject: 'u_ada' })).toBe(true);
  });
});

describe('scope comes from the ambient carrier', () => {
  const origins = makeOrigins(fakeIds(clock));

  it('reads tenant and actor without being handed them', () => {
    // `flags` is an observer rather than a stamper — PROVENANCE.md §3.
    const provenance = origins.forBoot().withTenant('t_acme');
    const flags = build();

    const inside = Carrier.run(provenance, () =>
      flags.decide('checkout.new_flow'),
    );

    expect(inside.rule).toBe('acme');
    // Outside the carrier there is no tenant, so nothing matches.
    expect(flags.decide('checkout.new_flow').status).toBe('fallback');
  });

  it('lets a caller override what the carrier says', () => {
    const provenance = origins.forBoot().withTenant('t_other');
    const flags = build();

    const overridden = Carrier.run(provenance, () =>
      flags.decide('checkout.new_flow', { tenant: 't_acme' }),
    );

    expect(overridden.value).toBe('on');
  });
});

describe('every evaluation lands on the span', () => {
  it('records the key, the value and which rule matched', () => {
    // A flag decision that is invisible is a debugging session where nobody can
    // explain the behaviour.
    const spans = memoryTelemetry(clock);
    const flags = makeFlags({ source: staticSource(SEED), telemetry: spans });

    flags.enabled('checkout.new_flow', { tenant: 't_acme' });

    const span = spans.spans()[0];
    expect(span?.name).toBe('flag checkout.new_flow');
    expect(span?.attributes).toMatchObject({
      flag: 'checkout.new_flow',
      value: 'on',
      status: 'matched',
      rule: 'acme',
    });
    expect(spans.open()).toBe(0);
  });

  it('records an unknown key too, which is when it matters most', () => {
    const spans = memoryTelemetry(clock);
    makeFlags({ source: staticSource(SEED), telemetry: spans }).enabled(
      'no.such',
    );

    expect(spans.spans()[0]?.attributes).toMatchObject({ status: 'unknown' });
  });
});

describe('validation at boot', () => {
  it('refuses a key that is not <area>.<name>', () => {
    expect(isFlagKey('checkout.new_flow')).toBe(true);
    expect(isFlagKey('a.b.c')).toBe(true);
    for (const bad of ['checkout', 'Checkout.flow', '.flow', 'a.']) {
      expect(isFlagKey(bad), bad).toBe(false);
    }
  });

  it('refuses a duplicate key', () => {
    const twice: Flag[] = [
      { key: 'a.b', fallback: 'off', rules: [] },
      { key: 'a.b', fallback: 'on', rules: [] },
    ];

    expect(isErr(validate(twice))).toBe(true);
  });

  it('refuses an out-of-range percentage, so a typo fails at boot', () => {
    expect(
      isErr(
        validate([
          {
            key: 'a.b',
            fallback: 'off',
            rules: [{ when: { percentage: 1000 }, value: 'on' }],
          },
        ]),
      ),
    ).toBe(true);
  });
});

describe('serving stale', () => {
  /** A source whose backing data can change between reads. */
  function changing() {
    let current = JSON.stringify(SEED);
    const own = fakeClock();
    const source = fileSource({
      read: () => Promise.resolve(current),
      clock: own,
      ttl: seconds(10),
    });
    return {
      source,
      own,
      // An arrow property rather than a method, so destructuring it below does
      // not detach a `this` the linter has to worry about.
      set: (flags: readonly Flag[]): void => {
        current = JSON.stringify(flags);
      },
    };
  }

  it('answers from cache without waiting on the backing store', async () => {
    const { source } = changing();
    await source.start();

    // Synchronous. A flag check that awaited would be worse than a restart.
    expect(source.get('checkout.new_flow')).toBeDefined();
  });

  it('is EXPECTED to be stale on the first read after a write', async () => {
    // The consequence worth asserting rather than racing: `get` returns the old
    // value and starts a refresh. A test that slept here would be picking a
    // number and hoping.
    const { source, own, set } = changing();
    await source.start();

    set([{ key: 'checkout.new_flow', fallback: 'on', rules: [] }]);
    await own.advance(seconds(11));

    // Stale, on purpose.
    expect(source.get('checkout.new_flow')?.fallback).toBe('off');

    // The refresh it kicked off has now landed.
    await source.stop();
    expect(source.get('checkout.new_flow')?.fallback).toBe('on');
  });

  it('keeps serving the last good set when a refresh fails', async () => {
    // A malformed edit must not turn every flag off — that is the failure that
    // makes people stop trusting a file provider.
    const problems: unknown[] = [];
    const own = fakeClock();
    let body = JSON.stringify(SEED);
    const source = fileSource({
      read: () => Promise.resolve(body),
      clock: own,
      ttl: millis(1),
      onError: (e) => problems.push(e),
    });
    await source.start();

    body = '{not json';
    await own.advance(seconds(1));
    source.get('checkout.new_flow');
    await source.stop();

    expect(problems).toHaveLength(1);
    // Still serving.
    expect(source.get('checkout.new_flow')).toBeDefined();
  });

  it('refuses a flag set that is not an array, without dropping the old one', async () => {
    const problems: unknown[] = [];
    const own = fakeClock();
    let body = JSON.stringify(SEED);
    const source = fileSource({
      read: () => Promise.resolve(body),
      clock: own,
      ttl: millis(1),
      onError: (e) => problems.push(e),
    });
    await source.start();

    body = '{"not":"an array"}';
    await own.advance(seconds(1));
    source.get('a.b');
    await source.stop();

    expect(problems).toHaveLength(1);
    expect(source.get('checkout.new_flow')).toBeDefined();
  });
});

/**
 * The collection's cohort vectors.
 *
 * `../../../conformance/fixtures/vectors/flag-cohort.json`, read in place —
 * **not a copy, and not generated here.** This repository previously kept its
 * own 21-case candidate, which proved only that the code agreed with itself.
 * Collection decision 0009 is what that could not catch: six blueprints had
 * implemented the function and diverged on two axes, and the divergence
 * survived precisely because nobody's vectors crossed a sibling.
 *
 * **The fixture carries no `input` field.** The string contains a raw `0x1f`,
 * which is invisible in a committed text file and gets mangled by editors, so
 * the input is constructed here from `flag` and `subject`.
 *
 * Three of the eleven cases are **regressions rather than coverage**:
 * `("checkout.new_flow", "user:u-1")` and `("a", "b:c")` are subjects
 * containing `":"` that must bucket rather than reject, and `("ab", "c")`
 * against `("a", "b")` catches a separator dropped entirely.
 */
describe('the collection cohort vectors', () => {
  interface Case {
    readonly flag: string;
    readonly subject: string;
    readonly bucket: number;
  }

  const fixture = join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../conformance/fixtures/vectors/flag-cohort.json',
  );

  const vectors = existsSync(fixture)
    ? (JSON.parse(readFileSync(fixture, 'utf8')) as {
        buckets: number;
        cases: Case[];
      })
    : undefined;

  // Skipped by name in a standalone checkout, as the digest vectors are — the
  // root documents and fixtures live one directory up until publication.
  describe.skipIf(vectors === undefined)('as committed', () => {
    it('agrees on the bucket count', () => {
      expect(vectors?.buckets).toBe(BUCKETS);
    });

    it.each(vectors?.cases ?? [])(
      'bucket($flag, $subject) is $bucket',
      (one: Case) => {
        expect(bucketOf(one.flag, one.subject)).toBe(one.bucket);
      },
    );
  });
});
