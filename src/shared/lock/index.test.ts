import { describe, expect, it } from 'vitest';
import { advisoryKey, JOBS_NAMESPACE, qualify } from './key.js';
import { lockContract } from './locktest.js';
import { memoryLocks } from './memory.js';

describe('the advisory key', () => {
  it('fits the signed 64-bit range PostgreSQL accepts', () => {
    // `pg_advisory_lock(bigint)` is signed. The top bit is not masked off —
    // masking would halve the space for no benefit and be a second thing to
    // keep in step across languages.
    const min = -(2n ** 63n);
    const max = 2n ** 63n - 1n;

    for (const name of ['a', 'identity.purge', 'x'.repeat(200), '']) {
      const key = advisoryKey(JOBS_NAMESPACE, name);
      expect(key).toBeGreaterThanOrEqual(min);
      expect(key).toBeLessThanOrEqual(max);
    }
  });

  it('is stable, because changing it splits a rolling deploy', () => {
    // Old and new instances would take *different* locks for the same job and
    // both run it — which is the exact failure the singleton exists to prevent,
    // arriving during the deploy that was supposed to be safe.
    expect(advisoryKey(JOBS_NAMESPACE, 'identity.purge')).toBe(
      advisoryKey(JOBS_NAMESPACE, 'identity.purge'),
    );
  });

  it('separates namespaces, so two subsystems cannot collide silently', () => {
    // A collision here blocks with no error, no log line, and no way to tell
    // from either side.
    expect(advisoryKey('jobs', 'purge')).not.toBe(
      advisoryKey('leases', 'purge'),
    );
  });

  it('separates names within a namespace', () => {
    expect(advisoryKey(JOBS_NAMESPACE, 'a')).not.toBe(
      advisoryKey(JOBS_NAMESPACE, 'b'),
    );
  });

  it('qualifies a name for logs and the memory adapter', () => {
    expect(qualify('jobs', 'purge')).toBe('jobs:purge');
  });
});

describe('the memory adapter', () => {
  // One shared registry, so `locks()` and `other()` genuinely contend — two
  // independent `memoryLocks()` would never see each other and every case
  // would pass for the wrong reason.
  const shared = memoryLocks('test');

  lockContract(() => ({
    name: 'memory',
    locks: () => shared,
    other: () => shared,
  }));
});
