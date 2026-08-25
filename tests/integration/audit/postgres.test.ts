/**
 * `audit`'s log, against a real PostgreSQL. **Rung 2.**
 *
 * The same contract the memory adapter passes, plus the one thing only a
 * database gives: **idempotency that holds across processes.** The memory
 * adapter's `Set` is the same guarantee for one process; four replicas draining
 * the same outbox need the unique index, and this is where that is real.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../src/shared/postgres/index.js';
import { auditLogContract } from '../../../src/contexts/audit/app/ports.contract.js';
import {
  AuditRecord,
  recordId,
} from '../../../src/contexts/audit/domain/index.js';
import { postgresAuditLog } from '../../../src/contexts/audit/infra/postgres/index.js';
import {
  RECORDS_TABLE,
  auditMigrations,
} from '../../../src/contexts/audit/infra/postgres/schema.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;
let counter = 0;
const uuid = (seed: number): string =>
  `01a024c7-bbbb-7000-8000-${String(seed).padStart(12, '0')}`;

integration('postgres audit log', () => {
  beforeAll(async () => {
    schema = await withSchema();
    await migrate(schema.db, auditMigrations);
  });

  afterAll(async () => {
    await schema.close();
  });

  describe('the shared contract', () => {
    auditLogContract(() => ({
      name: 'postgres',
      log: () => postgresAuditLog(schema.db),
    }));
  });

  describe('what only a real database proves', () => {
    it('adds exactly one row for a redelivered event, however concurrent', async () => {
      // **Case 36 under real concurrency.** The memory adapter's `Set` proves
      // it for one process; four replicas draining the same outbox is what the
      // unique index is for, and a read-then-insert passes every sequential
      // case and fails this one.
      const log = postgresAuditLog(schema.db);
      const eventId = uuid(++counter);

      const attempts = Array.from({ length: 12 }, (_, index) =>
        log.append(
          AuditRecord.of({
            // A fresh record id per attempt, exactly as the subscriber mints
            // one per delivery. The dedupe key is the **event's** id.
            id: recordId(uuid(counter * 1000 + index)),
            eventId,
            event: 'identity.user.registered',
            actor: 'user:alice',
            subject: 'user:alice',
            requestId: uuid(counter + 1),
            correlationId: uuid(counter + 2),
            occurredAt: new Date('2026-08-24T12:00:00.000Z'),
            recordedAt: new Date('2026-08-24T12:00:00.000Z'),
          }),
        ),
      );

      const outcomes = await Promise.all(attempts);

      expect(outcomes.filter(Boolean)).toHaveLength(1);

      const rows = await schema.db.query<{ n: string }>(
        `select count(*) as n from ${RECORDS_TABLE} where event_id = $1`,
        [eventId],
      );
      expect(rows[0]?.n).toBe('1');
    });

    it('stores an absent field as NULL rather than as an empty string', async () => {
      // Case 38a: absent is omitted, never `null` **on the wire** — and in the
      // column, absent is NULL rather than `''`, so the round trip preserves
      // the distinction instead of inventing a tenant called nothing.
      const log = postgresAuditLog(schema.db);
      const eventId = uuid(++counter);

      await log.append(
        AuditRecord.of({
          id: recordId(uuid(counter + 5000)),
          eventId,
          event: 'identity.user.registered',
          actor: 'system:boot',
          requestId: uuid(counter + 3),
          correlationId: uuid(counter + 4),
          occurredAt: new Date('2026-08-24T12:00:00.000Z'),
          recordedAt: new Date('2026-08-24T12:00:00.000Z'),
        }),
      );

      const row = await schema.db.queryRow<{
        tenant: string | null;
        causation_id: string | null;
        subject: string | null;
      }>(
        `select tenant, causation_id, subject from ${RECORDS_TABLE}
          where event_id = $1`,
        [eventId],
      );

      expect(row?.tenant).toBeNull();
      expect(row?.causation_id).toBeNull();
      expect(row?.subject).toBeNull();
    });

    it('has an index a prefix query can actually use', async () => {
      // **The reason `text_pattern_ops` is on that index.** The default opclass
      // uses the database's collation, and `like 'identity.%'` will not use an
      // index built with it — which turns every prefix search into a scan of
      // the biggest table here, silently and only once there is data in it.
      //
      // `enable_seqscan = off` makes the planner state its preference rather
      // than pick a scan because this table has twenty rows.
      await schema.db.exec('set enable_seqscan = off');
      try {
        const plan = await schema.db.query<{ 'QUERY PLAN': string }>(
          `explain select id from ${RECORDS_TABLE}
            where event like 'identity.%' escape '\\'`,
        );
        const text = plan.map((line) => line['QUERY PLAN']).join('\n');

        expect(text).toContain(`${RECORDS_TABLE}_event_prefix`);
      } finally {
        await schema.db.exec('set enable_seqscan = on');
      }
    });
  });
});
