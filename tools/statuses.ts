/**
 * `make statuses` — **which declared statuses this repository has ever been
 * observed to produce.**
 *
 * `../ENFORCEMENT.md`'s `S11` proves a route *declares every status its chain
 * can produce*. It does not prove the converse — that a route produces every
 * status it declares — and the collection now says so in one sentence:
 *
 * > **A declared status is a claim nothing checks.**
 *
 * This repository supplied the example. `PATCH /v1/users/{id}` declared `428`
 * with a comment reading *which is why 428 is here*, and answered `400` for six
 * phases. S11 was green throughout, correctly, on its own terms.
 *
 * **It matters because `openapi` publishes the declaration either way.** An
 * unproduced status is documentation of behaviour that does not exist, and a
 * client generator will build a branch for it.
 *
 * ## Observation, not enforcement
 *
 * The converse cannot be decided statically — a status reachable only when a
 * dependency is down is legitimate and no suite creates that on purpose. So
 * this **reports** and never fails. A rule that failed here would be suppressed
 * within a week, and a suppressed rule is worse than a report nobody automated.
 *
 * ## It reads the access log, and touches no production code
 *
 * Position 2 already logs `method`, `path` and `status` for every request. The
 * concrete path is matched back to its template here, offline, so nothing in
 * `src/` learns it is being measured — which also means the numbers come from
 * whatever actually ran, including the conformance runner driving a real
 * binary, rather than from a harness written to produce them.
 *
 *     make statuses LOG=path/to/serve.log
 */

import { readFileSync } from 'node:fs';
import { allRoutes } from '../src/wire.js';
import { GLOBAL_STATUSES } from '../src/shared/httproute/index.js';

const source = process.argv[2] ?? process.env['LOG'];
if (source === undefined) {
  process.stderr.write('usage: make statuses LOG=<access log>\n');
  process.exit(2);
}

/** `path=/v1/users/01a0…` and `status=200`, wherever they sit on the line. */
const LINE = /\bmethod=(\w+)\b.*?\bpath=(\S+).*?\bstatus=(\d{3})\b/;

/**
 * `/v1/users/:id` as a matcher.
 *
 * A parameter matches one segment and never a `/`, so `/v1/users/:id` does not
 * swallow `/v1/users/:id/roles` — the distinction that makes the busiest two
 * routes in the table separable at all.
 */
function matcher(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

const routes = allRoutes().map((route) => ({
  method: route.method,
  path: route.path,
  match: matcher(route.path),
  declared: new Set(Object.keys(route.replies).map(Number)),
  seen: new Set<number>(),
}));

let lines = 0;
let unmatched = 0;

for (const line of readFileSync(source, 'utf8').split('\n')) {
  const found = LINE.exec(line);
  if (found === null) continue;
  lines += 1;

  const [, method, rawPath, status] = found;
  // The query string is not part of a route's identity.
  const path = (rawPath ?? '').split('?')[0] ?? '';
  const route = routes.find(
    (one) => one.method === method && one.match.test(path),
  );
  if (route === undefined) {
    // Probes and 404s for paths no route owns. Counted, not listed: a stream of
    // them means the log came from a different service, which is worth seeing.
    unmatched += 1;
    continue;
  }
  route.seen.add(Number(status));
}

const out = (text: string): void => void process.stdout.write(`${text}\n`);

out(`statuses: ${String(lines)} requests read from ${source}`);
out(`          ${String(unmatched)} matched no route in this process`);
out('');

const untouched = routes.filter((one) => one.seen.size === 0);
const claims: string[] = [];
const undeclared: string[] = [];

for (const route of routes) {
  if (route.seen.size === 0) continue;
  const name = `${route.method.padEnd(6)} ${route.path}`;

  // **`GLOBAL_STATUSES` are exempt from the declaration**, so they are exempt
  // from the diff: a route that never returned 500 is a route nothing broke.
  const never = [...route.declared]
    .filter((status) => !route.seen.has(status))
    .filter((status) => !GLOBAL_STATUSES.includes(status))
    .sort((a, b) => a - b);
  if (never.length > 0) claims.push(`${name}  ${never.join(' ')}`);

  const extra = [...route.seen]
    .filter((status) => !route.declared.has(status))
    .filter((status) => !GLOBAL_STATUSES.includes(status))
    .sort((a, b) => a - b);
  if (extra.length > 0) undeclared.push(`${name}  ${extra.join(' ')}`);
}

if (undeclared.length > 0) {
  // If this is ever non-empty, `S11` has a hole — a status escaped a
  // declaration. That IS statically decidable and the rule owns it, so it is
  // printed first and loudly.
  out('PRODUCED AND NOT DECLARED — S11 should have caught these:');
  for (const row of undeclared) out(`  ${row}`);
  out('');
}

out('DECLARED AND NEVER PRODUCED — dead, or a lie, or simply unreached:');
if (claims.length === 0) {
  out('  (none)');
} else {
  for (const row of claims) out(`  ${row}`);
}
out('');

out(
  `UNEXERCISED ROUTES — ${String(untouched.length)} of ${String(routes.length)}:`,
);
for (const route of untouched) {
  out(`  ${route.method.padEnd(6)} ${route.path}`);
}
