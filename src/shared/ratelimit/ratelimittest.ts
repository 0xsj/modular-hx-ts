/**
 * One contract suite; both adapters pass it. **Test tooling** — rule `S3`.
 *
 * Separate tests would prove both adapters work. **One suite run twice proves
 * they agree**, which is what `I2` is about.
 *
 * **The case that matters is `two limiters over one store`.** Every other case
 * here passes against a private per-process map, which is not a rate limit at
 * all: four replicas each admitting the configured rate admit four times it,
 * and no single-instance test ever notices. Without that case the memory twin
 * and the shared adapter agree while one of them is wrong — which is the
 * failure mode that looks exactly like success.
 */

import { describe, expect, it } from 'vitest';
import { type Millis, millis } from '../clock/index.js';
import { type Limit } from './bucket.js';
import { type Buckets } from './port.js';

export interface Subject {
  readonly name: string;
  /** A limiter over the shared store. Called twice where that matters. */
  readonly buckets: () => Buckets;
  /**
   * The window every case here uses. **One number, for both adapters now.**
   *
   * It used to be the adapter's choice, because the two paid for it
   * differently: the twin drove an injected clock and a ten-second window cost
   * nothing, while the shared adapter had to *wait* — `now()` lived inside
   * PostgreSQL, where no injected clock reached. So the refill cases below,
   * which are the ones a bucket exists for, ran against a real ten seconds in
   * one adapter and a fake instant in the other.
   *
   * `MODULES.md` §5 moved the reading into `take`, and this is the payoff: one
   * fake clock drives both, the shared adapter waits for nothing, and refill is
   * asserted identically on each. Every case is still written in fractions of
   * the window, which is what makes the contract the behaviour rather than the
   * number.
   */
  readonly window: Millis;
}

let counter = 0;
const nextKey = (): string => `contract-${String(++counter)}`;

/**
 * The one clock both adapters read.
 *
 * A module-level instant rather than a fixture, because it is the *argument*
 * every call passes: with the reading in `take`, "advance time" is one
 * assignment and needs no adapter cooperation at all.
 */
let instant = new Date('2026-01-01T00:00:00.000Z');
const now = (): Date => instant;
const advance = (duration: Millis): void => {
  instant = new Date(instant.getTime() + duration);
};

/** Drain a bucket, returning how many were admitted. */
async function drain(
  buckets: Buckets,
  key: string,
  attempts: number,
  limit: Limit,
): Promise<number> {
  let admitted = 0;
  for (let i = 0; i < attempts; i++) {
    const decision = await buckets.take(key, limit, now());
    if (decision.allowed) admitted += 1;
  }
  return admitted;
}

export function bucketContract(subject: () => Subject): void {
  const limitFor = (s: Subject): Limit => ({ limit: 5, window: s.window });
  const fraction = (s: Subject, of: number): Millis => millis(s.window * of);
  describe('taking', () => {
    it('admits up to the limit and refuses the next', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const key = nextKey();

      expect(await drain(s.buckets(), key, 5, LIMIT)).toBe(5);
      expect((await s.buckets().take(key, LIMIT, now())).allowed).toBe(false);
    });

    it('counts down remaining as it goes', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const key = nextKey();

      expect((await b.take(key, LIMIT, now())).remaining).toBe(4);
      expect((await b.take(key, LIMIT, now())).remaining).toBe(3);
      expect((await b.take(key, LIMIT, now())).remaining).toBe(2);
    });

    it('reports the limit it was given', async () => {
      const s = subject();

      expect(
        (await s.buckets().take(nextKey(), limitFor(s), now())).limit,
      ).toBe(5);
    });

    it('does not let one key spend another key`s budget', async () => {
      // Conformance case 40: limits are **per caller, never global**. A limiter
      // with one shared counter passes every case above and fails this one.
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const mine = nextKey();
      const theirs = nextKey();

      await drain(b, mine, 5, LIMIT);

      expect((await b.take(theirs, LIMIT, now())).allowed).toBe(true);
    });
  });

  describe('check-and-consume is atomic', () => {
    it('admits exactly the limit under a burst, never one more', async () => {
      // Read-then-write means two concurrent requests both observe the last
      // token and both are admitted. The same trap as `idempotency`'s claim,
      // and the failure in production is a limit that leaks under exactly the
      // load it was installed for.
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const key = nextKey();

      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => b.take(key, LIMIT, now())),
      );

      expect(outcomes.filter((o) => o.allowed)).toHaveLength(5);
    });

    it('admits exactly the limit across two limiters at once', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const first = s.buckets();
      const second = s.buckets();
      const key = nextKey();

      const outcomes = await Promise.all([
        ...Array.from({ length: 10 }, () => first.take(key, LIMIT, now())),
        ...Array.from({ length: 10 }, () => second.take(key, LIMIT, now())),
      ]);

      expect(outcomes.filter((o) => o.allowed)).toHaveLength(5);
    });
  });

  describe('two limiters over one store', () => {
    it('shares one budget rather than one each', async () => {
      // **The case that distinguishes a real limiter from a local one.** Two
      // limiters are two replicas: a private per-process bucket admits ten here
      // and calls it five, and nothing else in this file notices.
      const s = subject();
      const LIMIT = limitFor(s);
      const first = s.buckets();
      const second = s.buckets();
      const key = nextKey();

      const admitted =
        (await drain(first, key, 3, LIMIT)) +
        (await drain(second, key, 3, LIMIT));

      expect(admitted).toBe(5);
    });

    it('shows one replica the spend of another', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const first = s.buckets();
      const second = s.buckets();
      const key = nextKey();

      await drain(first, key, 4, LIMIT);

      // Not 4: the second replica reads the same bucket, not its own.
      expect((await second.take(key, LIMIT, now())).remaining).toBe(0);
    });

    it('refuses at the second replica once the first has drained it', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const first = s.buckets();
      const second = s.buckets();
      const key = nextKey();

      await drain(first, key, 5, LIMIT);

      expect((await second.take(key, LIMIT, now())).allowed).toBe(false);
    });
  });

  describe('refilling', () => {
    it('refills by elapsed duration, not on a window boundary', async () => {
      // A token bucket has no boundary to wait for: spend five, wait two fifths
      // of the window, and two are back.
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const key = nextKey();

      await drain(b, key, 5, LIMIT);
      advance(fraction(s, 0.4));

      expect(await drain(b, key, 3, LIMIT)).toBe(2);
    });

    it('never refills past the limit, however long it waits', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const key = nextKey();

      await b.take(key, LIMIT, now());
      advance(fraction(s, 3));

      // Six waits would be a burst of 30 if the bucket kept accruing.
      expect(await drain(b, key, 8, LIMIT)).toBe(5);
    });

    it('reports a reset a client can act on', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const key = nextKey();

      await drain(b, key, 5, LIMIT);
      const refused = await b.take(key, LIMIT, now());

      expect(refused.allowed).toBe(false);
      // One token at five per ten seconds is two seconds away.
      expect(refused.resetAfter).toBeGreaterThan(0);
      expect(refused.resetAfter).toBeLessThanOrEqual(fraction(s, 0.25));
    });

    it('reports reset zero while tokens remain', async () => {
      // The reading `Reset` carries here: *how long until your next request is
      // admitted*. There is nothing to wait for.
      const s = subject();

      expect(
        (await s.buckets().take(nextKey(), limitFor(s), now())).resetAfter,
      ).toBe(0);
    });
  });

  describe('purging', () => {
    it('drops buckets that have refilled and keeps ones still spending', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const idle = nextKey();
      const busy = nextKey();

      await b.take(idle, LIMIT, now());
      advance(fraction(s, 1.1));
      await b.take(busy, LIMIT, now());

      await b.purge(LIMIT, now());

      // Dropping a full bucket changes no answer — it is indistinguishable from
      // one that never existed — while a bucket mid-spend must survive, or a
      // purge becomes a free refill.
      expect((await b.take(busy, LIMIT, now())).remaining).toBe(3);
    });
  });

  describe('a limit is per limit, not per store', () => {
    it('honours a tighter limit on the same key', async () => {
      // The degraded fallback leans on this: the same key, a smaller share.
      const s = subject();
      const b = s.buckets();
      const key = nextKey();
      const tight: Limit = { limit: 2, window: s.window };

      expect(await drain(b, key, 4, tight)).toBe(2);
    });

    it('does not go negative when the limit shrinks under a full bucket', async () => {
      const s = subject();
      const LIMIT = limitFor(s);
      const b = s.buckets();
      const key = nextKey();

      await drain(b, key, 5, LIMIT);
      const decision = await b.take(key, { limit: 1, window: s.window }, now());

      expect(decision.remaining).toBeGreaterThanOrEqual(0);
    });
  });
}
