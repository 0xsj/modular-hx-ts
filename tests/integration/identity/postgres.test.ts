/**
 * `identity`'s store, against a real PostgreSQL. **Rung 2.**
 *
 * The same contract suite the memory adapter passes, plus the two things only a
 * database provides:
 *
 * - a **unique index** that holds under concurrency, where the memory
 *   adapter's check is a read this process performed;
 * - a **transaction**, so the outbox row and the data write commit together or
 *   not at all — `ARCHITECTURE.md` §4, and the one property the memory
 *   `Transactor` explicitly does not claim.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '../../../src/shared/clock/index.js';
import { Kind, kindOf } from '../../../src/shared/errors/index.js';
import { memoryEvents } from '../../../src/shared/events/index.js';
import { fakeIds } from '../../../src/shared/id/index.js';
import { migrate } from '../../../src/shared/postgres/index.js';
import { makeOrigins } from '../../../src/shared/provenance/index.js';
import { identityStoreContract } from '../../../src/contexts/identity/app/ports.contract.js';
import {
  User,
  email,
  passwordHash,
  userId,
} from '../../../src/contexts/identity/domain/index.js';
import {
  postgresReaders,
  postgresTransactor,
} from '../../../src/contexts/identity/infra/postgres/index.js';
import {
  USERS_TABLE,
  identityMigrations,
} from '../../../src/contexts/identity/infra/postgres/schema.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;

const clock = fakeClock();
const publisher = memoryEvents({ clock, ids: fakeIds(clock) });

let counter = 0;
const nextId = () =>
  userId(`01a024c7-2222-7000-8000-${String(++counter).padStart(12, '0')}`);

integration('postgres identity store', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, identityMigrations);
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    identityStoreContract(() => ({
      name: 'postgres',
      transactor: postgresTransactor({ db: schema.db, publisher }),
      read: () => postgresReaders(schema.db),
    }));
  });

  describe('what only a real database proves', () => {
    it('lets exactly one of two concurrent signups win', async () => {
      // **The reason uniqueness is the repository's job** (§2.1). A
      // read-then-insert has a window, and this is the window: both callers
      // read *absent*, both insert, and only the index can decide.
      const address = email(`race-${String(++counter)}@example.com`);
      const transactor = postgresTransactor({ db: schema.db, publisher });

      const attempts = Array.from({ length: 8 }, () =>
        transactor
          .within((work) =>
            work.users.create(
              User.register(
                nextId(),
                address,
                passwordHash('argon2:x'),
                clock.now(),
              ),
            ),
          )
          .then(
            () => 'created' as const,
            (error: unknown) => kindOf(error),
          ),
      );

      const outcomes = await Promise.all(attempts);

      expect(outcomes.filter((o) => o === 'created')).toHaveLength(1);
      expect(outcomes.filter((o) => o === Kind.Conflict)).toHaveLength(7);
    });

    it('rolls the whole unit back, data and event together', async () => {
      // §4: the outbox row is written in the **same** transaction as the data
      // write. The memory `Transactor` cannot demonstrate this and does not
      // claim to; here the failure is real and so is the rollback.
      const address = email(`rollback-${String(++counter)}@example.com`);
      const transactor = postgresTransactor({ db: schema.db, publisher });
      const origins = makeOrigins(fakeIds(clock));

      await expect(
        transactor.within(async (work) => {
          await work.users.create(
            User.register(nextId(), address, undefined, clock.now()),
          );
          await work.publish(
            {
              name: 'identity.user.registered',
              payload: { subject: 'x', email: address },
            },
            origins.forRequest(),
          );
          throw new Error('the handler failed after both writes');
        }),
      ).rejects.toThrow('the handler failed after both writes');

      // The user is gone, which is the half a caller notices.
      expect(
        await postgresReaders(schema.db).users.byEmail(address),
      ).toBeUndefined();
    });

    it('stores no password as NULL rather than as an empty string', async () => {
      // §2.2's "a user is not their credentials", as a column. An empty string
      // would be a value somebody eventually compares a hash against.
      const address = email(`sso-${String(++counter)}@example.com`);
      const transactor = postgresTransactor({ db: schema.db, publisher });
      const user = User.register(nextId(), address, undefined, clock.now());

      await transactor.within((work) => work.users.create(user));

      const row = await schema.db.queryRow<{ password_hash: string | null }>(
        `select password_hash from ${USERS_TABLE} where id = $1`,
        [user.id],
      );

      expect(row?.password_hash).toBeNull();
      expect(
        (await postgresReaders(schema.db).users.byId(user.id))?.hasPassword,
      ).toBe(false);
    });
  });
});
