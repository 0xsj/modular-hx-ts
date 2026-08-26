/**
 * `make routes` — every route this process serves.
 *
 * **`allRoutes()` from the composition root**, which is the one list `wire`
 * mounts. This file kept its own copy for a while, and so did `make openapi`
 * and `make curl` — three lists of *which context tables exist*, and the first
 * time that mattered was the first time it was wrong.
 */

import { allRoutes } from '../src/wire.js';

const routes = allRoutes();

const rows = routes
  .map((route) => ({
    method: route.method,
    path: route.path,
    auth: route.auth === 'required' ? 'authenticated' : 'public',
  }))
  .sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );

const width = Math.max(...rows.map((r) => r.path.length));
for (const row of rows) {
  process.stdout.write(
    `${row.method.padEnd(6)} ${row.path.padEnd(width)}  ${row.auth}\n`,
  );
}
// The probes are the root's own — `health` is a shared module, not a context.
process.stdout.write(`GET    ${'/healthz'.padEnd(width)}  public\n`);
process.stdout.write(`GET    ${'/readyz'.padEnd(width)}  public\n`);
