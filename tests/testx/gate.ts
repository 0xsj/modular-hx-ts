/**
 * The rung-2 gate: skip with a reason, never fail, when there is no database.
 *
 * `../../INFRASTRUCTURE.md` §1 makes rung 0 the rung that needs nothing, and a
 * suite that goes red on a fresh clone with no Docker is a suite people stop
 * reading — after which a real failure in it is indistinguishable from the
 * usual noise. `../conformance/README.md` states the other half: **a skip is a
 * result, not a pass**, so it names what was missing rather than going quiet.
 *
 * The probe itself runs once per run in `global-setup.ts`, not here.
 */

import { describe, inject } from 'vitest';

/** Whether this run has a database, decided once before any file loaded. */
export const database = inject('database');

/**
 * Declare an integration suite that skips, with a reason, when there is none.
 *
 * The reason goes in the **title**, because that is what a runner prints for a
 * skipped suite; the global setup also writes it once to stderr for the default
 * reporter, which prints only a count.
 */
export function integration(name: string, body: () => void): void {
  if (database.ok) {
    describe(name, body);
    return;
  }
  describe.skip(`${name} — SKIPPED: ${database.reason}`, body);
}
