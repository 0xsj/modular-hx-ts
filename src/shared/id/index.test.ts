import { describe, expect, it } from 'vitest';
import { fakeClock, millis, seconds } from '../clock/index.js';
import { systemRandom } from '../random/index.js';
import { Kind } from '../errors/index.js';
import { isErr, unwrap } from '../result/index.js';
import {
  fakeIds,
  isUuid,
  parseUuid,
  sequencer,
  systemIds,
  timestampOf,
  type RandomBytes,
} from './index.js';

/** Deterministic bytes, so a generator's output can be written down exactly. */
const countingBytes: RandomBytes = (count) =>
  Uint8Array.from({ length: count }, (_, index) => index + 1);

const zeroBytes: RandomBytes = (count) => new Uint8Array(count);

/** The real entropy source, wired the way the composition root will wire it. */
const realBytes: RandomBytes = (count) => systemRandom().bytes(count);

const version = (id: string): string => id[14] ?? '';
const variant = (id: string): string => id[19] ?? '';

describe('structure', () => {
  it('is a canonical UUIDv7', () => {
    const id = systemIds(fakeClock(), realBytes).uuid();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(isUuid(id)).toBe(true);
    expect(version(id)).toBe('7');
  });

  it('sets version and variant on every id, however it was seeded', () => {
    const ids = [
      systemIds(fakeClock(), zeroBytes).uuid(),
      systemIds(fakeClock(), countingBytes).uuid(),
      systemIds(fakeClock(), realBytes).uuid(),
      fakeIds(fakeClock()).uuid(),
    ];

    for (const id of ids) {
      expect(version(id)).toBe('7');
      expect('89ab').toContain(variant(id));
    }
  });

  it('lays the bytes out where RFC 9562 says', () => {
    // A golden value: any change to the encoding breaks this deliberately.
    // Counter seed 0x098 from the injected bytes, variant byte 0x81, then
    // random bytes 02…08 verbatim.
    const ids = systemIds(fakeClock(), countingBytes);

    expect(ids.uuid()).toBe('019b76da-a800-7098-8102-030405060708');
    expect(ids.uuid()).toBe('019b76da-a800-7099-8102-030405060708');
  });
});

describe('time ordering', () => {
  it('sorts as a plain string in creation order', () => {
    // The reason for v7 over v4: an id column is a usable sort key, so a
    // B-tree does not fragment and keyset pagination means something.
    const clock = fakeClock();
    const ids = systemIds(clock, zeroBytes);
    const minted: string[] = [];

    for (let index = 0; index < 25; index++) {
      minted.push(ids.uuid());
      void clock.advance(millis(3));
    }

    expect([...minted].sort()).toEqual(minted);
  });

  it('stays ordered inside a single millisecond', async () => {
    // The case that breaks naive v7: a burst of inserts within one millisecond.
    // RFC 9562 §6.2 method 1 turns rand_a into a counter so ordering survives.
    const clock = fakeClock();
    const ids = systemIds(clock, zeroBytes);

    const burst = Array.from({ length: 500 }, () => ids.uuid());

    expect(clock.monotonic()).toBe(0);
    expect([...burst].sort()).toEqual(burst);
    expect(new Set(burst).size).toBe(500);

    // And ordering continues to hold across the millisecond boundary.
    await clock.advance(millis(1));
    expect(ids.uuid() > (burst.at(-1) ?? '')).toBe(true);
  });

  it('seeds the counter from randomness, not from zero', () => {
    // A counter starting at zero would publish how many ids that millisecond
    // had produced. Two generators at the same instant must differ.
    const first = systemIds(fakeClock(), countingBytes).uuid();
    const second = systemIds(fakeClock(), zeroBytes).uuid();

    expect(first).not.toBe(second);
    expect(first.slice(0, 13)).toBe(second.slice(0, 13)); // same timestamp
  });

  it('survives the counter wrapping', () => {
    // Twelve bits is 4096 ids in one millisecond. Past that it wraps, which is
    // a real ordering gap and must at least not corrupt the id.
    const ids = systemIds(fakeClock(), zeroBytes);
    const burst = Array.from({ length: 4200 }, () => ids.uuid());

    for (const id of [burst.at(0), burst.at(-1)]) {
      expect(version(id ?? '')).toBe('7');
      expect(isUuid(id ?? '')).toBe(true);
    }
  });
});

describe('timestampOf', () => {
  it('recovers the instant the id was minted', async () => {
    const clock = fakeClock();
    const ids = systemIds(clock, zeroBytes);

    await clock.advance(seconds(90));
    const id = ids.uuid();

    expect(unwrap(timestampOf(id)).toISOString()).toBe(
      clock.now().toISOString(),
    );
  });

  it('refuses a UUID that is not version 7', () => {
    // A plausible wrong Date is worse than a refusal.
    const v4 = unwrap(parseUuid('9f1a2b3c-4d5e-4f60-8a7b-1c2d3e4f5a6b'));

    const result = timestampOf(v4);

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.kind).toBe(Kind.Invalid);
  });
});

describe('parseUuid', () => {
  it('accepts a canonical id', () => {
    expect(unwrap(parseUuid('019b76da-a800-7098-8102-030405060708'))).toBe(
      '019b76da-a800-7098-8102-030405060708',
    );
  });

  it('normalizes case and surrounding whitespace', () => {
    // The same id arriving uppercase from one client and lowercase from
    // another must not become two rows.
    expect(unwrap(parseUuid('  019B76DA-A800-7098-8102-030405060708 '))).toBe(
      '019b76da-a800-7098-8102-030405060708',
    );
  });

  it('rejects everything that is not one', () => {
    const rejects = [
      '',
      'not-a-uuid',
      '019b76da a800 7098 8102 030405060708',
      '019b76daa80070988102030405060708',
      '019b76da-a800-0098-8102-030405060708', // version 0
      '019b76da-a800-7098-c102-030405060708', // bad variant
      '019b76da-a800-7098-8102-03040506070',
    ];

    for (const value of rejects) {
      const result = parseUuid(value);
      expect(isErr(result), `expected ${value} to be rejected`).toBe(true);
    }
  });

  it('never echoes the value it rejected', () => {
    const result = parseUuid('sk_live_51H8yQwErTyUiOpAsDfGh');

    expect(isErr(result) && result.error.message).toBe('not a valid UUID');
  });
});

describe('fakeIds', () => {
  it('produces a sequence a test can write down', () => {
    const ids = fakeIds(fakeClock());

    expect(ids.uuid()).toBe('019b76da-a800-7000-8000-000000000000');
    expect(ids.uuid()).toBe('019b76da-a800-7001-8000-000000000000');
  });

  it('produces ids the real parser accepts', () => {
    // A fake emitting something the parser rejects is a fake that hides bugs.
    const id = fakeIds(fakeClock()).uuid();

    expect(isUuid(id)).toBe(true);
    expect(unwrap(parseUuid(id))).toBe(id);
  });

  it('remembers what it minted, in order', () => {
    const ids = fakeIds(fakeClock());
    const first = ids.uuid();
    const second = ids.uuid();

    expect(ids.minted()).toEqual([first, second]);
  });

  it('tracks the clock it was given', async () => {
    const clock = fakeClock();
    const ids = fakeIds(clock);

    const before = ids.uuid();
    await clock.advance(seconds(60));
    const after = ids.uuid();

    expect(after > before).toBe(true);
    expect(unwrap(timestampOf(after)).getTime()).toBe(clock.now().getTime());
  });
});

describe('sequencer', () => {
  it('counts from one, zero-padded, behind a prefix', () => {
    const next = sequencer('usr');

    expect(next()).toBe('usr_000001');
    expect(next()).toBe('usr_000002');
  });

  it('takes a width', () => {
    expect(sequencer('org', 3)()).toBe('org_001');
  });

  it('does not truncate once it outgrows the width', () => {
    const next = sequencer('job', 2);
    for (let index = 0; index < 100; index++) next();

    expect(next()).toBe('job_101');
  });

  it('is independent per sequencer', () => {
    const users = sequencer('usr');
    const orgs = sequencer('org');

    expect(users()).toBe('usr_000001');
    expect(orgs()).toBe('org_000001');
  });
});
