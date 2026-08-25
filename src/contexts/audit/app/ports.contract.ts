/**
 * One contract suite; both adapters pass it. **Test tooling** — rule `S3`.
 *
 * The cases are the ones where an adapter can be plausibly wrong: the
 * idempotency constraint, the prefix boundary, and the scope that must AND
 * rather than replace.
 */

import { describe, expect, it } from 'vitest';
import { AuditRecord, recordId, type Scope } from '../domain/index.js';
import { type AuditLog } from './ports.js';

export interface Subject {
  readonly name: string;
  readonly log: () => AuditLog;
}

/** Narrow, and fail at the read rather than blaming the next line. */
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

let counter = 0;
const uuid = (seed: number): string =>
  `01a024c7-aaaa-7000-8000-${String(seed).padStart(12, '0')}`;

const AT = new Date('2026-08-24T12:00:00.000Z');
const ALL: Scope = { kind: 'all' };

function record(over: Partial<Parameters<typeof AuditRecord.of>[0]> = {}) {
  const n = ++counter;
  return AuditRecord.of({
    id: recordId(uuid(n)),
    eventId: uuid(n + 500_000),
    event: 'identity.user.registered',
    actor: 'user:alice',
    subject: 'user:alice',
    requestId: uuid(n + 100_000),
    correlationId: uuid(n + 200_000),
    occurredAt: AT,
    recordedAt: AT,
    ...over,
  });
}

export function auditLogContract(subject: () => Subject): void {
  describe('appending', () => {
    it('records what it was given', async () => {
      const s = subject();
      const one = record();

      expect(await s.log().append(one)).toBe(true);

      const found = await s.log().search({ limit: 50 }, ALL);
      expect(found.map((r) => r.eventId)).toContain(one.eventId);
    });

    it('is idempotent by EVENT id — case 36', async () => {
      // Delivery is at-least-once, so a redelivery is normal traffic. It must
      // add no row, and it must not throw: a subscriber that failed on one
      // would dead-letter its way through a healthy queue.
      const s = subject();
      const one = record();

      expect(await s.log().append(one)).toBe(true);
      expect(await s.log().append(one)).toBe(false);

      const found = await s.log().search({ limit: 50 }, ALL);
      expect(found.filter((r) => r.eventId === one.eventId)).toHaveLength(1);
    });

    it('treats a different record id for one event as the same event', async () => {
      // The dedupe key is the **event's** id, not the record's. A redelivery
      // arrives with a fresh record id because the subscriber mints one per
      // attempt, and keying on that would store every redelivery.
      const s = subject();
      const first = record();
      const again = record({
        id: recordId(uuid(++counter + 900_000)),
        eventId: first.eventId,
      });

      await s.log().append(first);
      expect(await s.log().append(again)).toBe(false);
    });

    it('keeps absent fields absent rather than empty', async () => {
      // Case 38a: absent is omitted, never `null`. A record whose tenant is
      // unknown must not come back claiming to belong to `''`.
      const s = subject();
      const bare = record({ causationId: undefined, tenant: undefined });

      await s.log().append(bare);
      const found = (await s.log().search({ limit: 50 }, ALL)).find(
        (r) => r.eventId === bare.eventId,
      );

      expect(found?.state.causationId).toBeUndefined();
      expect(found?.state.tenant).toBeUndefined();
      expect(found?.toWire()).not.toHaveProperty('tenant');
    });
  });

  describe('querying', () => {
    it('filters by exact event name', async () => {
      const s = subject();
      const wanted = record({ event: 'identity.session.created' });
      await s.log().append(wanted);
      await s.log().append(record({ event: 'identity.user.registered' }));

      const found = await s
        .log()
        .search({ event: 'identity.session.created', limit: 50 }, ALL);

      expect(
        found.every((r) => r.state.event === 'identity.session.created'),
      ).toBe(true);
      expect(found.map((r) => r.eventId)).toContain(wanted.eventId);
    });

    it('filters by event PREFIX, with the dot as the boundary', async () => {
      // §2.5: dots are the prefix boundary, so `identity.user.` matches
      // `identity.user.registered` and not `identity.session.created`.
      const s = subject();
      const user = record({ event: 'identity.user.disabled' });
      const session = record({ event: 'identity.session.created' });
      await s.log().append(user);
      await s.log().append(session);

      const found = await s
        .log()
        .search({ prefix: 'identity.user.', limit: 50 }, ALL);
      const ids = found.map((r) => r.eventId);

      expect(ids).toContain(user.eventId);
      expect(ids).not.toContain(session.eventId);
    });

    it('matches a whole context with the shorter prefix', async () => {
      const s = subject();
      const user = record({ event: 'identity.user.disabled' });
      const session = record({ event: 'identity.session.created' });
      await s.log().append(user);
      await s.log().append(session);

      const ids = (
        await s.log().search({ prefix: 'identity.', limit: 50 }, ALL)
      ).map((r) => r.eventId);

      expect(ids).toContain(user.eventId);
      expect(ids).toContain(session.eventId);
    });

    it('filters by correlation, which is how a request is reconstructed', async () => {
      const s = subject();
      const correlationId = uuid(++counter + 700_000);
      const mine = record({ correlationId });
      await s.log().append(mine);
      await s.log().append(record());

      const found = await s.log().search({ correlationId, limit: 50 }, ALL);

      expect(found.map((r) => r.eventId)).toEqual([mine.eventId]);
    });

    it('filters by actor and by subject independently', async () => {
      const s = subject();
      const acted = record({ actor: 'user:bob', subject: 'user:carol' });
      await s.log().append(acted);

      expect(
        (await s.log().search({ actor: 'user:bob', limit: 50 }, ALL)).map(
          (r) => r.eventId,
        ),
      ).toContain(acted.eventId);
      expect(
        (await s.log().search({ subject: 'user:carol', limit: 50 }, ALL)).map(
          (r) => r.eventId,
        ),
      ).toContain(acted.eventId);
      // And not the other way round, or the two filters are one filter.
      expect(
        (await s.log().search({ actor: 'user:carol', limit: 50 }, ALL)).map(
          (r) => r.eventId,
        ),
      ).not.toContain(acted.eventId);
    });

    it('filters by a time window', async () => {
      const s = subject();
      const old = record({ occurredAt: new Date('2026-01-01T00:00:00.000Z') });
      const recent = record({
        occurredAt: new Date('2026-08-24T12:00:00.000Z'),
      });
      await s.log().append(old);
      await s.log().append(recent);

      const ids = (
        await s
          .log()
          .search(
            { since: new Date('2026-06-01T00:00:00.000Z'), limit: 50 },
            ALL,
          )
      ).map((r) => r.eventId);

      expect(ids).toContain(recent.eventId);
      expect(ids).not.toContain(old.eventId);
    });

    it('returns newest first', async () => {
      const s = subject();
      const first = record({
        occurredAt: new Date('2026-08-24T10:00:00.000Z'),
      });
      const second = record({
        occurredAt: new Date('2026-08-24T11:00:00.000Z'),
      });
      await s.log().append(first);
      await s.log().append(second);

      const found = await s.log().search({ limit: 50 }, ALL);
      const positions = [
        found.findIndex((r) => r.eventId === second.eventId),
        found.findIndex((r) => r.eventId === first.eventId),
      ];

      expect(positions[0]).toBeLessThan(present(positions[1], 'a position'));
    });

    it('honours the limit', async () => {
      const s = subject();
      for (let i = 0; i < 5; i++) await s.log().append(record());

      expect(await s.log().search({ limit: 2 }, ALL)).toHaveLength(2);
    });
  });

  describe('scope — case 37', () => {
    const OWN: Scope = { kind: 'own', id: 'user:dave' };

    it('shows a caller records where they are the ACTOR', async () => {
      const s = subject();
      const mine = record({ actor: 'user:dave', subject: 'user:erin' });
      await s.log().append(mine);

      expect(
        (await s.log().search({ limit: 50 }, OWN)).map((r) => r.eventId),
      ).toContain(mine.eventId);
    });

    it('shows a caller records where they are the SUBJECT', async () => {
      // The one that matters: being disabled by an administrator is a record
      // where somebody else acted, and it is the record you most want to find.
      const s = subject();
      const done = record({ actor: 'user:admin', subject: 'user:dave' });
      await s.log().append(done);

      expect(
        (await s.log().search({ limit: 50 }, OWN)).map((r) => r.eventId),
      ).toContain(done.eventId);
    });

    it('shows nothing of somebody else`s', async () => {
      const s = subject();
      const theirs = record({ actor: 'user:erin', subject: 'user:frank' });
      await s.log().append(theirs);

      expect(
        (await s.log().search({ limit: 50 }, OWN)).map((r) => r.eventId),
      ).not.toContain(theirs.eventId);
    });

    it('ANDs with a filter rather than being replaced by it', async () => {
      // **The escalation this prevents.** A caller narrowing to
      // `actor=somebody-else` must still see nothing — the scope is a separate
      // argument the adapter ANDs in, not a default the query overrides.
      const s = subject();
      const theirs = record({ actor: 'user:erin', subject: 'user:frank' });
      await s.log().append(theirs);

      const found = await s
        .log()
        .search({ actor: 'user:erin', limit: 50 }, OWN);

      expect(found.map((r) => r.eventId)).not.toContain(theirs.eventId);
    });
  });
}
