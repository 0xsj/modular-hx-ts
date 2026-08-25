/**
 * The **same** journey, against a real database.
 *
 * `../../INFRASTRUCTURE.md` §1 rung 3. The body is `journey.ts` — one file, two
 * callers — because the whole claim of `I2` is that the port has two
 * implementations answering identically, and two copies of a journey would stop
 * proving that the first time somebody edited one.
 *
 * **Skips with a reason when there is no database**, never fails: a suite that
 * goes red on a fresh clone is a suite people stop reading. `make e2e` in CI
 * has the stack up, and the skip names what was missing.
 *
 * Migrations are applied by the suite rather than assumed: the process serves,
 * it does not migrate — `main.ts migrate` is a separate command, on purpose,
 * because a process that migrates on boot migrates once per replica.
 */

import { describe } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probe } from '../testx/probe.js';
import { testDsn } from '../testx/postgres.js';
import { theJourney } from './journey.js';

const dsn = testDsn();
const reachable = await probe(dsn);

if (!reachable.ok) {
  describe.skip(`the journey, against Postgres — SKIPPED: ${reachable.reason}`, () => {
    // Vitest needs a body; the title carries the result.
  });
} else {
  // **The real `migrate` command, not `migrate()` imported.** The list it
  // applies was `[]` while every test was green, and only the binary reads it.
  execFileSync('node', ['--import', 'tsx', 'src/main.ts', 'migrate'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      DATABASE_URL: dsn,
      LOG_FORMAT: 'json',
    },
    stdio: 'pipe',
  });

  theJourney({
    mode: 'against Postgres',
    env: { STORAGE: 'postgres', DATABASE_URL: dsn },
    artifact: 'artifacts/e2e-journal-postgres.md',
  });
}
