import { describe, expect, it } from 'vitest';
import { must } from '../assert/index.js';
import { Kind } from '../errors/index.js';
import { isErr, isOk, unwrap } from '../result/index.js';
import {
  DEFAULT_LIMITS,
  decodeCursor,
  encodeCursor,
  paginate,
  resolveLimit,
  type Cursor,
} from './index.js';

const ORDER = 'users.created_at.desc';

interface Row {
  readonly id: string;
  readonly createdAt: string;
}

const rows = (count: number, from = 1): Row[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `usr_${String(from + index).padStart(6, '0')}`,
    createdAt: `2026-01-${String(from + index).padStart(2, '0')}T00:00:00.000Z`,
  }));

const positionOf = (row: Row): [string, string] => [row.createdAt, row.id];

describe('resolveLimit', () => {
  it('falls back when nothing was asked for', () => {
    expect(resolveLimit(undefined)).toBe(DEFAULT_LIMITS.fallback);
  });

  it('honours a sensible request', () => {
    expect(resolveLimit(5)).toBe(5);
    expect(resolveLimit(100)).toBe(100);
  });

  it('clamps rather than refusing', () => {
    // ?limit=10000 is far more often a client guessing than an attack, and a
    // 400 teaches nothing. The cap is the protection either way.
    expect(resolveLimit(10_000)).toBe(DEFAULT_LIMITS.max);
    expect(resolveLimit(0)).toBe(1);
    expect(resolveLimit(-5)).toBe(1);
  });

  it('handles the values a query string actually produces', () => {
    expect(resolveLimit(Number.NaN)).toBe(DEFAULT_LIMITS.fallback);
    expect(resolveLimit(Infinity)).toBe(DEFAULT_LIMITS.fallback);
    expect(resolveLimit(7.9)).toBe(7);
  });

  it('takes a policy', () => {
    const policy = { fallback: 2, max: 3 };

    expect(resolveLimit(undefined, policy)).toBe(2);
    expect(resolveLimit(50, policy)).toBe(3);
  });

  it('refuses a policy that contradicts itself', () => {
    expect(() => resolveLimit(1, { fallback: 10, max: 5 })).toThrow();
    expect(() => resolveLimit(1, { fallback: 1, max: 0 })).toThrow();
  });
});

describe('cursors', () => {
  it('round-trips a position', () => {
    const cursor = unwrap(encodeCursor(ORDER, ['2026-01-01', 'usr_000001']));

    expect(unwrap(decodeCursor(ORDER, cursor))).toEqual([
      '2026-01-01',
      'usr_000001',
    ]);
  });

  it('is URL-safe, so it survives a query string unescaped', () => {
    const cursor = unwrap(
      encodeCursor(ORDER, {
        createdAt: '2026-01-01T00:00:00.000Z',
        id: 'a/b+c',
      }),
    );

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodeURIComponent(cursor)).toBe(cursor);
  });

  it('is deterministic, because the body is canonical JSON', () => {
    // Same position, different construction order, same cursor.
    const a = unwrap(encodeCursor(ORDER, { id: 'usr_1', at: '2026-01-01' }));
    const b = unwrap(encodeCursor(ORDER, { at: '2026-01-01', id: 'usr_1' }));

    expect(a).toBe(b);
  });

  it('refuses a cursor minted for a different ordering', () => {
    // The same values mean something else under a different sort, and replaying
    // one listing's cursor against another silently returns the wrong page.
    const cursor = unwrap(encodeCursor('users.name.asc', ['Ada']));

    const result = decodeCursor(ORDER, cursor);

    expect(isErr(result)).toBe(true);
    expect(isErr(result) && result.error.kind).toBe(Kind.Invalid);
    expect(isErr(result) && result.error.message).toBe(
      'cursor is for a different ordering',
    );
  });

  it('refuses anything that is not a cursor, without echoing it', () => {
    // Caller-supplied, and an error message is a log line.
    const junk = [
      '',
      'not-base64!!',
      'YWJj',
      Buffer.from('{}').toString('base64url'),
    ];

    for (const value of junk) {
      const result = decodeCursor(ORDER, value as Cursor);
      expect(isErr(result), `expected ${value} to be refused`).toBe(true);
      expect(isErr(result) && result.error.message).toBe(
        'cursor is not readable',
      );
    }
  });

  it('refuses a position JSON cannot carry', () => {
    expect(isErr(encodeCursor(ORDER, Number.NaN))).toBe(true);
  });
});

describe('paginate', () => {
  it('returns everything and no cursor when the page is not full', () => {
    const page = unwrap(paginate(rows(3), 10, ORDER, positionOf));

    expect(page.items).toHaveLength(3);
    expect(page.next).toBeUndefined();
  });

  it('returns exactly the limit and no cursor when the last page is exact', () => {
    // The over-fetch is what distinguishes "exactly full" from "there is more",
    // and getting it wrong shows an empty final page to every client.
    const page = unwrap(paginate(rows(10), 10, ORDER, positionOf));

    expect(page.items).toHaveLength(10);
    expect(page.next).toBeUndefined();
  });

  it('trims the over-fetched row and offers a cursor', () => {
    const page = unwrap(paginate(rows(11), 10, ORDER, positionOf));

    expect(page.items).toHaveLength(10);
    expect(page.items.at(-1)?.id).toBe('usr_000010');
    expect(page.next).toBeDefined();
  });

  it('positions the cursor on the last returned row, not the discarded one', () => {
    // Off by one here skips a row on every page boundary, and the symptom is a
    // missing record nobody knew to look for.
    const page = unwrap(paginate(rows(11), 10, ORDER, positionOf));
    const next = must(page.next, 'a full page offers a cursor');

    expect(unwrap(decodeCursor(ORDER, next))).toEqual(
      positionOf(must(rows(11)[9], 'the tenth row')),
    );
  });

  it('walks a whole collection exactly once', () => {
    // The property that matters: every row appears, once, in order.
    const all = rows(25);
    const seen: Row[] = [];
    let offset = 0;

    for (let guard = 0; guard < 10; guard++) {
      const page = unwrap(
        paginate(all.slice(offset, offset + 11), 10, ORDER, positionOf),
      );
      seen.push(...page.items);
      if (page.next === undefined) break;
      offset += page.items.length;
    }

    expect(seen.map((row) => row.id)).toEqual(all.map((row) => row.id));
    expect(new Set(seen.map((row) => row.id)).size).toBe(25);
  });

  it('handles an empty result', () => {
    const page = unwrap(paginate([], 10, ORDER, positionOf));

    expect(page.items).toEqual([]);
    expect(page.next).toBeUndefined();
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => paginate(rows(3), 0, ORDER, positionOf)).toThrow();
    expect(() => paginate(rows(3), 1.5, ORDER, positionOf)).toThrow();
  });

  it('propagates a position that cannot be encoded', () => {
    const result = paginate(rows(11), 10, ORDER, () => Infinity);

    expect(isOk(result)).toBe(false);
  });
});
