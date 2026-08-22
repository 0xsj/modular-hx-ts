/**
 * Probe the database **once per run**, before any integration file loads.
 *
 * The first version of this probed at module scope in the gate, which meant
 * once per *worker*: a connection attempt and a duplicate stderr line for every
 * one vitest happened to spin up. On a machine with no database — the case the
 * probe exists for — that is the slowest possible way to find out, repeated.
 *
 * A global setup runs in the main process, once, and hands the answer to every
 * worker through `provide`.
 */

import type { TestProject } from 'vitest/node';
import { probe, type Reachability } from './probe.js';
import { testDsn } from './postgres.js';

declare module 'vitest' {
  interface ProvidedContext {
    database: Reachability;
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const database = await probe(testDsn());

  // The reason also lives in each skipped suite's title, but only the verbose
  // reporter prints those and the default reporter is what people run. A skip
  // whose cause is invisible reads as a pass.
  if (!database.ok) {
    process.stderr.write(
      `\nintegration suites skipped: ${database.reason}\n\n`,
    );
  }

  project.provide('database', database);
}
