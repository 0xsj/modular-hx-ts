/**
 * The journey, **in memory mode**. Rung 0 of the ladder, at rung 3's fidelity.
 *
 * `STORAGE=memory` with **zero external dependencies** — invariant `I1`. This
 * runs on a fresh clone with no Docker, no database and no network, which is
 * what makes it the one nobody is entitled to skip.
 */

import { theJourney } from './journey.js';

theJourney({
  mode: 'in memory mode',
  env: { STORAGE: 'memory' },
  artifact: 'artifacts/e2e-journal.md',
});
