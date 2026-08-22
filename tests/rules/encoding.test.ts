/**
 * Source files must be **text**.
 *
 * Not a numbered rule — `../../ENFORCEMENT.md` has no id for this — but it
 * earned a permanent test the hard way.
 *
 * `src/shared/digest/index.test.ts` carried three **raw control bytes**: a
 * `0x0f` inside RFC 8785's worked-example string, and a `0x00` and `0x1f` in the
 * assertion about escaping. TypeScript parsed all three happily, vitest ran
 * them, and all 34 tests passed. But a `NUL` makes `file(1)` report `data` and
 * makes **grep skip the file entirely** — so to any text tool, the fixture
 * wiring inside it did not exist.
 *
 * That hid finished work through four rounds of being told it was missing, and
 * no suite here could have caught it, because the suite is what was passing.
 * The same three bytes sit in `modular-hx-nest`, the other repository reported
 * as not having wired the fixtures — which it had.
 *
 * The fix in every case is the escape the code meant anyway: the six characters
 * `backslash u 0 0 0 0`, not the byte.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Everything git tracks, plus what it does not know about yet. */
function sourceFiles(): readonly string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return listed
    .split('\n')
    .filter((file) => /\.(ts|cjs|mjs|json|md|yml|yaml)$/.test(file));
}

/** Tab, newline and carriage return are the only control bytes text needs. */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

describe('every source file is text, not data', () => {
  it('contains no raw control bytes', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const bytes = readFileSync(join(repoRoot, file));
      const bad = [...bytes].filter(
        (byte) => byte < 0x20 && !ALLOWED.has(byte),
      );

      if (bad.length > 0) {
        const codes = [...new Set(bad)]
          .map((byte) => `0x${byte.toString(16).padStart(2, '0')}`)
          .join(' ');
        offenders.push(`${file} (${codes})`);
      }
    }

    // A NUL is the one that hurts: grep treats the file as binary and skips it
    // silently, so everything inside becomes invisible to every text tool while
    // the compiler and the test runner stay perfectly happy.
    expect(offenders).toEqual([]);
  });
});
