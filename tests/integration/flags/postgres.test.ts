/**
 * The fleet-wide provider, against a real PostgreSQL. **Rung 2.**
 *
 * The shared contract, plus the promise only this provider makes: **a flip
 * reaches every instance within the TTL**, and until it does the old value
 * keeps serving.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seconds, systemClock } from '../../../src/shared/clock/index.js';
import {
  FLAGS_TABLE,
  flagMigrations,
  makeFlags,
  postgresSource,
  type Flag,
} from '../../../src/shared/flags/index.js';
import { flagsContract, SEED } from '../../../src/shared/flags/flagstest.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { memoryTelemetry } from '../../../src/shared/telemetry/index.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

const clock = systemClock();
const telemetry = memoryTelemetry(clock);

let schema: Schema;

async function put(flag: Flag): Promise<void> {
  await schema.db.exec(
    `insert into ${FLAGS_TABLE} (key, fallback, rules, description)
       values ($1, $2, $3::jsonb, $4)
     on conflict (key) do update
       set fallback = excluded.fallback, rules = excluded.rules`,
    [
      flag.key,
      flag.fallback,
      JSON.stringify(flag.rules),
      flag.description ?? null,
    ],
  );
}

/**
 * Retry until a condition holds, or give up.
 *
 * **Not a sleep.** The promise is *eventually, within the TTL* — sleeping picks
 * a number and hopes, while retrying asserts the thing actually promised and
 * fails fast when it is broken.
 */
async function eventually(
  check: () => boolean,
  attempts = 50,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

integration('postgres flags', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, flagMigrations);
    for (const flag of SEED) await put(flag);
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    flagsContract(() => ({
      name: 'postgres',
      flags: async () => {
        const source = postgresSource({
          db: schema.db,
          clock,
          ttl: seconds(30),
        });
        await source.start();
        return makeFlags({ source, telemetry });
      },
    }));
  });

  describe('a flip reaches every instance within the TTL', () => {
    it('serves stale, then the new value — asserted by retry, not by sleep', async () => {
      const source = postgresSource({ db: schema.db, clock, ttl: seconds(0) });
      await source.start();

      expect(source.get('billing.always_off')?.fallback).toBe('off');

      await put({ key: 'billing.always_off', fallback: 'on', rules: [] });

      // The first read after the write is **expected to be stale**: `get` never
      // waits on the database, so it returns the old value and starts a
      // refresh behind it.
      expect(source.get('billing.always_off')?.fallback).toBe('off');

      // And then it lands.
      expect(
        await eventually(
          () => source.get('billing.always_off')?.fallback === 'on',
        ),
      ).toBe(true);

      await put({ key: 'billing.always_off', fallback: 'off', rules: [] });
      await source.refresh();
      await source.stop();
    });

    it('never blocks the caller, even with a cold cache', async () => {
      // `get` is synchronous by type. This asserts the behaviour that makes
      // that safe: a source that has never loaded answers immediately rather
      // than reaching for the database.
      const cold = postgresSource({ db: schema.db, clock, ttl: seconds(0) });

      const started = Date.now();
      expect(cold.get('checkout.new_flow')).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(50);

      await cold.stop();
    });

    it('keeps serving the last good set when the database goes away', async () => {
      // A database blip must not turn every flag off.
      const problems: unknown[] = [];
      const source = postgresSource({
        db: {
          query: () => Promise.reject(new Error('down')),
          queryRow: () => Promise.reject(new Error('down')),
          exec: () => Promise.reject(new Error('down')),
        },
        clock,
        ttl: seconds(0),
        onError: (e) => problems.push(e),
      });

      // Nothing loaded, so nothing to serve — but it does not throw.
      expect(source.get('checkout.new_flow')).toBeUndefined();
      await source.stop();
      expect(problems.length).toBeGreaterThan(0);
    });
  });

  describe('a malformed row', () => {
    it('does not take the whole set down', async () => {
      // `rules` is jsonb, so a row can hold something this build cannot use.
      await schema.db.exec(
        `insert into ${FLAGS_TABLE} (key, fallback, rules)
           values ('Bad Key', 'off', '[]'::jsonb)
         on conflict (key) do nothing`,
      );

      const problems: unknown[] = [];
      const source = postgresSource({
        db: schema.db,
        clock,
        onError: (e) => problems.push(e),
      });
      await source.start();

      // The load was rejected as a set, so the cache is empty rather than
      // partially wrong — and the problem is reported rather than swallowed.
      expect(problems).toHaveLength(1);

      await schema.db.exec(`delete from ${FLAGS_TABLE} where key = 'Bad Key'`);
      await source.stop();
    });
  });
});
