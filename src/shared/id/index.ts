/**
 * Identifiers. **L0 kernel** — pure, no I/O, no process state.
 *
 * Invariant I5: **time, randomness and identifiers are injected.** A module
 * that mints its own ids cannot be tested for what it stored, only that it
 * stored something.
 *
 * Both halves arrive as arguments. `systemClock` is the adapter for time and
 * `systemRandom` is the adapter for entropy; this is neither, it composes them,
 * so it defaults nothing and touches no platform API. Rule `I5` enforces that.
 *
 * UUIDv7 (RFC 9562): a 48-bit millisecond timestamp followed by randomness, so
 * ids sort by creation time as strings **and** as bytes. That is not cosmetic —
 * it is why a primary key does not fragment a B-tree the way UUIDv4 does, and
 * why keyset pagination over an id column is meaningful.
 *
 * See `notes/techniques/id.md`.
 */

import { type Brand, unsafeBrand } from '../brand/index.js';
import { type Clock } from '../clock/index.js';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/** A canonical, lowercase, hyphenated UUID. */
export type Uuid = Brand<string, 'Uuid'>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuid(value: string): value is Uuid {
  return UUID_PATTERN.test(value);
}

/**
 * Parse an untrusted string.
 *
 * Case-normalizing on the way in, because a UUID that arrives uppercase from
 * one client and lowercase from another is the same id, and a database unique
 * index will not agree.
 */
export function parseUuid(value: string): Result<Uuid> {
  const normalized = value.trim().toLowerCase();

  return isUuid(normalized) ? ok(normalized) : err(invalid('not a valid UUID'));
}

/**
 * The randomness `id` needs, declared by the consumer that needs it.
 *
 * `random` is a separate L0 module and is not built yet; when it lands it
 * supplies this. Declaring the interface here rather than waiting is the point
 * of consumer-declared ports — the dependency is named and fakeable today.
 */
export type RandomBytes = (count: number) => Uint8Array;

/** The port. */
export interface IdGenerator {
  /** A fresh, time-ordered UUIDv7. */
  uuid(): Uuid;
}

// --- encoding --------------------------------------------------------------

const HEX = Array.from({ length: 256 }, (_, byte) =>
  byte.toString(16).padStart(2, '0'),
);

/** O(1): sixteen table lookups, no allocation beyond the result. */
function format(bytes: Uint8Array): Uuid {
  let out = '';
  for (let index = 0; index < 16; index++) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += '-';
    out += HEX[bytes[index] ?? 0] ?? '00';
  }
  return unsafeBrand<string, 'Uuid'>(out);
}

/**
 * Lay out one UUIDv7.
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  ┌───────────────────────────────────────────────────────────────┐
 *  │                      unix_ts_ms (48 bits)                     │
 *  ├───────────────┬───────────────────────────────────────────────┤
 *  │  ver (0111)   │        counter / rand_a (12 bits)             │
 *  ├───┬───────────┴───────────────────────────────────────────────┤
 *  │var│                     rand_b (62 bits)                      │
 *  └───┴───────────────────────────────────────────────────────────┘
 */
function layout(
  timestampMs: number,
  counter: number,
  random: Uint8Array,
): Uint8Array {
  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp. Beyond 2^48 ms — the year 10889 — this wraps,
  // which is documented in RFC 9562 and is somebody else's problem.
  bytes[0] = (timestampMs / 2 ** 40) & 0xff;
  bytes[1] = (timestampMs / 2 ** 32) & 0xff;
  bytes[2] = (timestampMs / 2 ** 24) & 0xff;
  bytes[3] = (timestampMs / 2 ** 16) & 0xff;
  bytes[4] = (timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;

  // Version 7 in the high nibble, then twelve bits of counter.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // Variant 10 in the top two bits, then 62 bits of randomness.
  bytes[8] = 0x80 | ((random[0] ?? 0) & 0x3f);
  for (let index = 9; index < 16; index++) {
    bytes[index] = random[index - 8] ?? 0;
  }

  return bytes;
}

// --- the real one ----------------------------------------------------------

/**
 * A generator backed by a clock and a source of randomness.
 *
 * **Monotonic within a millisecond.** RFC 9562 §6.2 method 1: when two ids are
 * minted in the same millisecond, the twelve `rand_a` bits become a counter
 * rather than fresh randomness, so the second id still sorts after the first.
 * Without it, a burst of inserts inside one millisecond arrives in random
 * order, and "time-ordered" quietly stops being true exactly when it matters —
 * under load.
 *
 * The counter is seeded randomly per millisecond rather than at zero, so ids
 * do not leak how many were minted in that millisecond.
 */
export function systemIds(clock: Clock, randomBytes: RandomBytes): IdGenerator {
  let lastMs = -1;
  let counter = 0;

  return {
    uuid: () => {
      const nowMs = clock.now().getTime();
      const random = randomBytes(9);

      if (nowMs === lastMs) {
        counter = (counter + 1) & 0x0fff;
      } else {
        lastMs = nowMs;
        // Twelve bits of seed, leaving room to count within the millisecond.
        counter =
          (((random[8] ?? 0) << 4) | ((random[7] ?? 0) & 0x0f)) & 0x0fff;
      }

      return format(layout(nowMs, counter, random));
    },
  };
}

// --- the fake one ----------------------------------------------------------

export interface FakeIdGenerator extends IdGenerator {
  /** Every id minted so far, in order. */
  minted(): readonly Uuid[];
}

/**
 * A generator whose output a test can write down.
 *
 * Randomness is zero and the counter increments, so the ids are a readable
 * sequence and an assertion can name one exactly. They are still structurally
 * valid UUIDv7s — version and variant bits are correct — because a fake that
 * produces something the real parser rejects is a fake that hides bugs.
 */
export function fakeIds(clock: Clock): FakeIdGenerator {
  let counter = 0;
  const issued: Uuid[] = [];

  return {
    uuid: () => {
      const id = format(
        layout(clock.now().getTime(), counter++ & 0x0fff, new Uint8Array(9)),
      );
      issued.push(id);
      return id;
    },
    minted: () => issued,
  };
}

// --- reading one back ------------------------------------------------------

/**
 * The instant encoded in a UUIDv7.
 *
 * Useful in a debugger and in a support query — Postgres 18 exposes the same
 * thing as `uuid_extract_timestamp()`. Meaningless for other versions, so it
 * returns a `Result` rather than a plausible wrong answer.
 */
export function timestampOf(id: Uuid): Result<Date> {
  if (id[14] !== '7') return err(invalid('not a UUIDv7'));

  const hex = id.replaceAll('-', '').slice(0, 12);
  return ok(new Date(Number.parseInt(hex, 16)));
}

// --- human-readable ids ----------------------------------------------------

/**
 * A counter with a prefix: `usr_000001`, `usr_000002`.
 *
 * For seed data and fixtures, where a reader has to hold two ids in their head
 * at once and `01a024c7-…` and `01a024c8-…` are indistinguishable at a glance.
 * **Not for production rows**: it is guessable, it leaks volume, and it needs
 * coordination to stay unique across processes.
 */
export function sequencer(prefix: string, width = 6): () => string {
  let next = 0;
  return () => `${prefix}_${String(++next).padStart(width, '0')}`;
}
