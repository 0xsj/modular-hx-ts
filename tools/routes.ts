/**
 * `make routes` — every route this process serves.
 *
 * Read off the same tables `wire` mounts, so it cannot drift from what is
 * actually served. The collection asked five blueprints for their inventories
 * side by side; a count is not one, and a hand-written list is a different
 * document that happens to look like one.
 */

import { type IdentityDeps } from '../src/contexts/identity/index.js';
import { identityRoutes } from '../src/contexts/identity/transport/http/routes.js';
import { auditRoutes } from '../src/contexts/audit/transport/http/routes.js';

const routes = [
  ...identityRoutes({ deps: {} as IdentityDeps }, { defaultRoles: [] }),
  ...auditRoutes({ caller: () => undefined } as never),
];

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
