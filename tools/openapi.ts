/**
 * `make openapi` — write `docs/openapi.json`. **Generated, committed, diffed.**
 *
 * Walks the same route tables `wire` mounts, so the document cannot describe a
 * route the server does not serve, and cannot miss one it does.
 *
 * `--check` regenerates and compares instead of writing: that is what `make ci`
 * runs, and it is the third of `MODULES.md`'s three words. A schema change that
 * alters the published contract fails the build rather than shipping quietly.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Documented,
  generate,
  render,
} from '../src/shared/openapi/index.js';

import { allRoutes } from '../src/wire.js';

const OUT = fileURLToPath(new URL('../docs/openapi.json', import.meta.url));

/**
 * **`allRoutes()` from the composition root** — the one list `wire` mounts.
 *
 * This file kept its own copy, and the first time that mattered was the first
 * time it was wrong: `exports` landed with three routes and the committed spec
 * did not change, because the generator was walking a list that did not know
 * about them. **A drift check cannot catch a route the generator never sees.**
 *
 * Nothing here calls a handler — a route is a value, which is the module's own
 * rule rather than a convenience.
 */
const routes: readonly Documented[] = allRoutes();

const document = generate(routes, {
  title: 'modular-hx-ts',
  // **Not the build version.** The document describes the *contract*, and a
  // version that moved on every commit would make every build a diff — which
  // would make the drift check useless by making it always fire.
  version: '1.0.0',
  description:
    'Generated from the route registry by `make openapi`. Do not edit: ' +
    '`make ci` regenerates and fails if this file differs.',
});

const rendered = render(document);

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(OUT, 'utf8');
  } catch {
    process.stderr.write('docs/openapi.json is missing. Run `make openapi`.\n');
    process.exit(1);
  }

  if (committed !== rendered) {
    process.stderr.write(
      'docs/openapi.json is out of date: a route or a schema changed and the ' +
        'published contract did not.\n' +
        'Run `make openapi`, and review the diff — it is the contract change ' +
        'somebody else is about to receive.\n',
    );
    process.exit(1);
  }
  process.stdout.write('openapi: the committed spec matches the registry\n');
} else {
  writeFileSync(OUT, rendered, 'utf8');
  process.stdout.write(
    `openapi: wrote docs/openapi.json (${String(Object.keys(document['paths'] as object).length)} paths)\n`,
  );
}
