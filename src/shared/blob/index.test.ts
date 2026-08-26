/**
 * `blob`. The memory twin against the shared contract, plus **the keys**, which
 * are the module rather than a detail of it.
 */

import { describe, expect, it } from 'vitest';
import { fakeClock } from '../clock/index.js';
import { blobContract } from './blobtest.js';
import { blobKey, parseKey, within } from './key.js';
import { memoryBlobStore, memoryBlobs } from './memory.js';

const clock = fakeClock();

describe('memory adapter', () => {
  blobContract(() => ({
    name: 'memory',
    blobs: () => memoryBlobs(memoryBlobStore(), clock),
  }));
});

describe('keys — the validation IS the module', () => {
  it('builds one from a tenant and segments', () => {
    expect(blobKey('acme', 'exports', 'report.csv')).toBe(
      'acme/exports/report.csv',
    );
  });

  it.each([
    ['..'],
    ['.'],
    ['../etc'],
    ['a/b'],
    ['a\\b'],
    ['%2e%2e'],
    ['UPPER'],
    ['-leading'],
    [''],
    ['  '],
    ['a\u0000b'],
  ])('refuses %j as a segment', (part) => {
    // **An allow-list, and this is the argument for it.** A deny-list would
    // need a rule for each of these and one more for the encoding somebody
    // finds next; the pattern has nothing to remember.
    expect(() => blobKey('acme', part)).toThrow();
  });

  it('refuses a traversal in the TENANT too', () => {
    // The tenant is not the caller's to choose, and this is what makes that
    // true rather than assumed.
    expect(() => blobKey('..', 'exports')).toThrow();
  });

  it('refuses a key with no segment after the tenant', () => {
    // A key that is just a tenant addresses the whole tenant, which is not an
    // object and is a prefix somebody could delete.
    expect(() => blobKey('acme')).toThrow();
  });

  it('refuses one that is too long to be a key', () => {
    expect(() =>
      blobKey('acme', ...Array<string>(20).fill('a'.repeat(120))),
    ).toThrow();
  });

  it('refuses a leading dot, which IS the `.` and `..` rule', () => {
    // There is no separate relative-segment check: the pattern's first
    // character carries it. An explicit one lived here for a while and a
    // breakage pass showed it was dead — a redundant guard is a second place a
    // rule appears to live.
    expect(() => blobKey('acme', '.hidden')).toThrow();
    expect(() => blobKey('acme', '..')).toThrow();
    expect(() => blobKey('acme', '.')).toThrow();
  });

  it('allows a dot inside a segment, because filenames have extensions', () => {
    // The case a naive `includes('.')` deny-list breaks, which is why `.` and
    // `..` are checked as whole segments rather than as substrings.
    expect(blobKey('acme', 'report.2026.csv')).toBe('acme/report.2026.csv');
  });

  it('re-validates a key that came back from a store', () => {
    // A row is a string, and a string from a database is a string from
    // wherever the row came from.
    expect(parseKey('acme/exports/a.csv')).toBe('acme/exports/a.csv');
    expect(() => parseKey('acme/../etc/passwd')).toThrow();
  });

  it('answers whether a key is inside a tenant', () => {
    const key = blobKey('acme', 'exports', 'a.csv');

    expect(within(key, 'acme')).toBe(true);
    expect(within(key, 'other')).toBe(false);
    // **Not a prefix match on the raw string**: `acme-evil/` starts with
    // `acme` and is a different tenant, which is why the separator is in the
    // comparison.
    expect(within(key, 'acm')).toBe(false);
  });
});
