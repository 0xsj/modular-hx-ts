/**
 * `orgs` against a real PostgreSQL. **Rung 2.**
 *
 * The memory twin and this adapter answer the same questions, and one of them
 * is only real here: **the last-owner invariant under concurrency.** The
 * invariant spans the membership set, the check reads that set, and JavaScript
 * runs each memory callback to completion — so the memory adapter cannot
 * demonstrate the race the `for update` exists for. Two connections can.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/shared/postgres/index.js';
import { memoryEvents } from '../../../src/shared/events/index.js';
import { fakeClock } from '../../../src/shared/clock/index.js';
import { fakeIds } from '../../../src/shared/id/index.js';
import {
  Membership,
  OrgRole,
  Organization,
  membershipId,
  orgId,
} from '../../../src/contexts/orgs/domain/index.js';
import {
  postgresMemberships,
  postgresOrgs,
  postgresTransactor,
} from '../../../src/contexts/orgs/infra/postgres/index.js';
import { orgsMigrations } from '../../../src/contexts/orgs/infra/postgres/schema.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;
let counter = 0;
const uuid = (): string =>
  `01a024c7-cccc-7000-8000-${String(++counter).padStart(12, '0')}`;

const clock = fakeClock();

integration('postgres orgs', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, orgsMigrations);
  });

  afterAll(async () => {
    await schema.close();
  });

  async function anOrg(owners: number): Promise<{ id: string; ids: string[] }> {
    const org = Organization.found(orgId(uuid()), `Org ${uuid()}`, clock.now());
    await postgresOrgs(schema.db).create(org);

    const members: string[] = [];
    for (let i = 0; i < owners; i++) {
      const userId = uuid();
      members.push(userId);
      await postgresMemberships(schema.db).create(
        Membership.join(
          membershipId(uuid()),
          org.id,
          userId,
          OrgRole.Owner,
          clock.now(),
        ),
      );
    }
    return { id: org.id, ids: members };
  }

  describe('what only a real database proves', () => {
    it('keeps one owner when two demotions race', async () => {
      // **The case the invariant exists for, and the one the memory twin
      // cannot show.** Two owners, two concurrent demotions of *different*
      // people: each reads a roster with two owners, each concludes it may
      // proceed, and the organization ends with none. `roster()` reads
      // `for update`, so the second transaction blocks until the first
      // commits and then reads a roster with one.
      const org = await anOrg(2);
      const publisher = memoryEvents({ clock, ids: fakeIds(clock) });
      const transactor = postgresTransactor({ db: schema.db, publisher });

      const demote = (userId: string, hold?: Promise<void>) =>
        transactor.within(async (work) => {
          const roster = await work.memberships.roster(orgId(org.id));
          // The caller may keep this transaction open after its read, which is
          // what puts the two connections in contention.
          if (hold !== undefined) await hold;

          const owners = roster.filter((one) => one.role === OrgRole.Owner);
          if (owners.length <= 1) throw new Error('refused');

          const membership = await work.memberships.of(orgId(org.id), userId);
          if (membership === undefined) throw new Error('gone');
          membership.changeRole(OrgRole.Admin);
          await work.memberships.save(membership);
        });

      // **A is held open while B starts.** That is the only way to interleave
      // two real connections, and it is what the row lock is for: B's roster
      // read blocks until A commits, and then reads a roster with one owner.
      //
      // A barrier *both* transactions wait on cannot be used here — with
      // `for update` in place, B never reaches it, so the test would deadlock
      // rather than pass. The first version did exactly that, which is a
      // decent proof the lock is real and a useless test.
      let release: () => void = () => undefined;
      const held = new Promise<void>((resume) => {
        release = resume;
      });

      const settle = (ms: number) =>
        new Promise((resume) => setTimeout(resume, ms));

      // A reads the roster and parks, holding its transaction open.
      const first = demote(org.ids[0] ?? '', held);
      await settle(100);

      // B issues its roster read. **With the lock it blocks here**; without it
      // it reads a stale two-owner roster and proceeds.
      const second = demote(org.ids[1] ?? '');
      await settle(250);

      // Only now does A commit. Releasing before B had issued its read was the
      // first version of this, and it made the test pass with the lock
      // removed — A committed first, B read one owner and refused for the
      // ordinary reason. It proved nothing, and only a deliberate break
      // showed that.
      release();
      const outcomes = await Promise.allSettled([first, second]);

      const roster = await postgresMemberships(schema.db).roster(orgId(org.id));
      const owners = roster.filter((one) => one.role === OrgRole.Owner);

      expect(owners).toHaveLength(1);
      expect(outcomes.filter((one) => one.status === 'rejected')).toHaveLength(
        1,
      );
    });

    it('refuses a second membership for the same person', async () => {
      // Uniqueness is the repository`s: a concurrent double-accept loses at
      // the index rather than in a read the command performed.
      const org = await anOrg(1);
      const memberships = postgresMemberships(schema.db);
      const userId = uuid();

      const join = () =>
        memberships.create(
          Membership.join(
            membershipId(uuid()),
            orgId(org.id),
            userId,
            OrgRole.Member,
            clock.now(),
          ),
        );

      const outcomes = await Promise.allSettled([join(), join()]);

      expect(outcomes.filter((one) => one.status === 'fulfilled')).toHaveLength(
        1,
      );
    });

    it('refuses a second organization with the same slug', async () => {
      const orgs = postgresOrgs(schema.db);
      const name = `Duplicate ${uuid()}`;

      const found = () =>
        orgs.create(Organization.found(orgId(uuid()), name, clock.now()));

      const outcomes = await Promise.allSettled([found(), found()]);

      expect(outcomes.filter((one) => one.status === 'fulfilled')).toHaveLength(
        1,
      );
    });

    it('loses an update on a stale version', async () => {
      const org = await anOrg(1);
      const orgs = postgresOrgs(schema.db);

      const first = await orgs.byId(orgId(org.id));
      const second = await orgs.byId(orgId(org.id));
      if (first === undefined || second === undefined) throw new Error('gone');

      first.rename('Renamed once', clock.now());
      await orgs.save(first);

      second.rename('Renamed twice', clock.now());

      await expect(orgs.save(second)).rejects.toThrow();
    });

    it('lists a user`s organizations across the join', async () => {
      // The read `identity`'s `OrgRoles` port is built on, and the one that
      // runs on every authenticated request.
      const org = await anOrg(1);
      const userId = org.ids[0] ?? '';

      const mine = await postgresOrgs(schema.db).forUser(userId);

      expect(mine.map((one) => one.id)).toContain(org.id);
    });
  });
});
