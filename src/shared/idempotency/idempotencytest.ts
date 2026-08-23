/**
 * One contract suite; both adapters pass it. **Test tooling** — rule `S3`.
 *
 * Separate tests would prove both adapters work. **One suite run twice proves
 * they agree**, which is the property `I2` is actually about — a repository can
 * swap `STORAGE=memory` for PostgreSQL and get the same answers, not merely two
 * sets of passing tests.
 *
 * **Real time, not a fake clock.** The two clocks are the substance of this
 * module and one of them lives inside PostgreSQL as `now()`, where no injected
 * clock can reach it. A suite that faked time here would assert the memory
 * adapter's arithmetic twice and the thing that matters never — so the leases
 * are short and the waits are real.
 */

import { describe, expect, it } from 'vitest';
import { type Millis, millis } from '../clock/index.js';
import { type Digest, digest } from '../digest/index.js';
import { unwrap } from '../result/index.js';
import { type ScopedKey } from './key.js';
import { type RecordOptions, type Records } from './port.js';

export interface Subject {
  readonly name: string;
  /** A fresh view of the same store. Options vary per case. */
  readonly records: (options?: RecordOptions) => Records;
}

let counter = 0;
/** A fresh key per case, so one leaked claim cannot fail the next test. */
const nextKey = (over: Partial<ScopedKey> = {}): ScopedKey => ({
  tenant: 't_acme',
  principal: 'user:01a024c7-d2d6-7e71-8c87-e344e27ef844',
  key: `contract-${String(++counter)}`,
  ...over,
});

const print = (value: unknown): Digest => unwrap(digest(value));
const A = print({ amount: 100 });
const B = print({ amount: 200 });

/** `Millis` is branded, so the suite spells it out rather than casting. */
const millisecondsFor = (value: number): Millis => millis(value);

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RESPONSE = {
  status: 201,
  headers: { 'content-type': 'application/json', location: '/payments/1' },
  body: '{"id":"pay_1","amount":100}',
};

export function recordsContract(subject: () => Subject): void {
  describe('claiming', () => {
    it('claims a key nobody holds', async () => {
      const r = subject().records();

      expect(await r.claim(nextKey(), A)).toEqual({ outcome: 'claimed' });
    });

    it('refuses a second claim while the first is in flight', async () => {
      // Conformance case 27.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);

      expect(await r.claim(key, A)).toEqual({ outcome: 'in-flight' });
    });

    it('lets exactly one of many simultaneous claims through', async () => {
      // **The reason this port exists.** Read-then-write passes every test
      // above and fails this one, and the failure in production is a double
      // charge rather than a red test.
      const r = subject().records();
      const key = nextKey();

      const outcomes = await Promise.all(
        Array.from({ length: 8 }, () => r.claim(key, A)),
      );

      expect(outcomes.filter((o) => o.outcome === 'claimed')).toHaveLength(1);
      expect(outcomes.filter((o) => o.outcome === 'in-flight')).toHaveLength(7);
    });
  });

  describe('replaying', () => {
    it('replays a completed response bit for bit', async () => {
      // Conformance case 25.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.complete(key, RESPONSE);

      expect(await r.claim(key, A)).toEqual({
        outcome: 'replay',
        response: RESPONSE,
      });
    });

    it('refuses the same key with a different request', async () => {
      // Conformance case 26.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.complete(key, RESPONSE);

      expect(await r.claim(key, B)).toEqual({ outcome: 'mismatch' });
    });

    it('reports a mismatch ahead of an in-flight claim', async () => {
      // A client that changed its payload gets the answer it can act on. Told
      // 409 it would retry and get 422 anyway, one round trip later.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);

      expect(await r.claim(key, B)).toEqual({ outcome: 'mismatch' });
    });
  });

  describe('the key is scoped, never global', () => {
    it('does not let one tenant see another tenant`s response', async () => {
      // **The cross-tenant read.** A bare key makes this pass a replay across
      // the fence, and nothing else in the suite would catch it: every other
      // case uses one tenant, where a global key behaves identically.
      const r = subject().records();
      const shared = `shared-${String(++counter)}`;

      const acme = nextKey({ tenant: 't_acme', key: shared });
      const other = nextKey({ tenant: 't_globex', key: shared });

      await r.claim(acme, A);
      await r.complete(acme, RESPONSE);

      // Same key string, different tenant: a fresh claim, not a replay.
      expect(await r.claim(other, A)).toEqual({ outcome: 'claimed' });
    });

    it('does not let one principal see another principal`s response', async () => {
      const r = subject().records();
      const shared = `shared-${String(++counter)}`;

      const alice = nextKey({ principal: 'user:alice', key: shared });
      const bob = nextKey({ principal: 'user:bob', key: shared });

      await r.claim(alice, A);
      await r.complete(alice, RESPONSE);

      expect(await r.claim(bob, A)).toEqual({ outcome: 'claimed' });
    });
  });

  describe('releasing', () => {
    it('makes a released key claimable again', async () => {
      // The mechanism behind conformance case 28.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.release(key);

      expect(await r.claim(key, A)).toEqual({ outcome: 'claimed' });
    });

    it('forgets a released response rather than replaying it', async () => {
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.complete(key, RESPONSE);
      await r.release(key);

      expect(await r.claim(key, A)).toEqual({ outcome: 'claimed' });
    });
  });

  describe('a key spent past the cap', () => {
    it('answers definitively rather than replaying or re-running', async () => {
      // The handler ran and its writes are durable; the response was too large
      // to hold. **Releasing would let a retry double-apply it** — losing
      // replay is a cost, losing the guarantee is a failure.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.consume(key);

      expect(await r.claim(key, A)).toEqual({ outcome: 'consumed' });
    });

    it('is not mistaken for a replay, and carries no response', async () => {
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.consume(key);
      const claim = await r.claim(key, A);

      expect(claim.outcome).not.toBe('replay');
      expect(claim).not.toHaveProperty('response');
    });

    it('still reports a mismatch ahead of itself', async () => {
      // A different payload is a different request, and the answer a client can
      // act on is the same whether the earlier one was stored or spent.
      const r = subject().records();
      const key = nextKey();

      await r.claim(key, A);
      await r.consume(key);

      expect(await r.claim(key, B)).toEqual({ outcome: 'mismatch' });
    });

    it('expires on the response clock, not the lease', async () => {
      // A spent key is *finished*, so the lease no longer applies to it — the
      // same rule as a completed one, and the reason `consume` is a sibling of
      // `complete` rather than of `release`.
      const r = subject().records({
        leaseFor: millisecondsFor(200),
        ttl: millisecondsFor(60_000),
      });
      const key = nextKey();

      await r.claim(key, A);
      await r.consume(key);
      await wait(400);

      expect(await r.claim(key, A)).toEqual({ outcome: 'consumed' });
    });

    it('is forgotten once its window closes', async () => {
      const r = subject().records({ ttl: millisecondsFor(300) });
      const key = nextKey();

      await r.claim(key, A);
      await r.consume(key);
      await wait(500);

      expect(await r.claim(key, A)).toEqual({ outcome: 'claimed' });
    });
  });

  describe('two clocks, kept apart', () => {
    it('reclaims a key whose claimant died — but not before the lease', async () => {
      // **The crash test.** Claim, never complete, and assert the key is
      // honoured until the lease and reclaimable after it. Without the lease
      // this key is in flight forever and case 27's 409 becomes permanent: a
      // client locked out of an operation it never completed, freeable only by
      // an operator with database access.
      const r = subject().records({ leaseFor: millisecondsFor(400) });
      const key = nextKey();

      await r.claim(key, A);

      // Still honoured. The claimant might merely be slow.
      expect(await r.claim(key, A)).toEqual({ outcome: 'in-flight' });

      await wait(600);

      // Presumed dead.
      expect(await r.claim(key, A)).toEqual({ outcome: 'claimed' });
    });

    it('does not let a short lease shorten a long replay window', async () => {
      // **What one column cannot do.** The lease is over the moment the handler
      // finishes; the replay window has hours left. Collapsed into one column,
      // completing a request would either extend the lease to the TTL — so a
      // crashed claim is held for a day — or expire the response with the
      // lease, and case 25 stops working a few seconds after it starts.
      const r = subject().records({
        leaseFor: millisecondsFor(200),
        ttl: millisecondsFor(60_000),
      });
      const key = nextKey();

      await r.claim(key, A);
      await r.complete(key, RESPONSE);

      await wait(400);

      // The lease expired long ago and changes nothing: this record is
      // completed, and completed records answer to the other clock.
      expect(await r.claim(key, A)).toEqual({
        outcome: 'replay',
        response: RESPONSE,
      });
    });

    it('forgets a completed response once its window closes', async () => {
      const r = subject().records({ ttl: millisecondsFor(300) });
      const key = nextKey();

      await r.claim(key, A);
      await r.complete(key, RESPONSE);
      await wait(500);

      // Forgotten, so a retry executes afresh rather than replaying something
      // the client has long stopped expecting.
      expect(await r.claim(key, A)).toEqual({ outcome: 'claimed' });
    });
  });

  describe('purging', () => {
    it('drops expired records and keeps live ones', async () => {
      const r = subject().records({ ttl: millisecondsFor(300) });
      const dead = nextKey();
      const live = subject().records({ ttl: millisecondsFor(60_000) });
      const liveKey = nextKey();

      await r.claim(dead, A);
      await r.complete(dead, RESPONSE);
      await live.claim(liveKey, A);
      await live.complete(liveKey, RESPONSE);

      await wait(500);
      await r.purge();

      expect(await r.claim(dead, A)).toEqual({ outcome: 'claimed' });
      expect(await live.claim(liveKey, A)).toEqual({
        outcome: 'replay',
        response: RESPONSE,
      });
    });

    it('leaves an in-flight claim alone, expired lease or not', async () => {
      // An expired lease means *reclaimable*, not *garbage*. Purging one would
      // erase the evidence that a claimant went missing, which is exactly what
      // somebody debugging a stuck key needs to see.
      const r = subject().records({ leaseFor: millisecondsFor(200) });
      const key = nextKey();

      await r.claim(key, A);
      await wait(400);

      expect(await r.purge()).toBe(0);
    });
  });
}
