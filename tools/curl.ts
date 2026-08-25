/**
 * `make curl` — the real journey, as runnable commands. **Rung 0a.**
 *
 * > A person who clones this can reach something in five minutes.
 *
 * **Generated, never written.** Hand-maintained example requests drift within a
 * week and then mislead, which is worse than having none — a request that
 * cannot be regenerated from the source of truth is a request that no longer
 * exists. This reads the **route table** the server mounts, so a path that
 * moves moves here on the next run, and a route that does not exist cannot be
 * printed.
 *
 * The collection's own runner has `--emit-curl` over `spec/`, which prints the
 * *conformance cases*. This prints the **journey** — register, log in, look
 * around, change something, watch it in the audit log — because that is the
 * thing a stranger wants first and no case file describes it end to end.
 */

import { type IdentityDeps } from '../src/contexts/identity/index.js';

const BASE = process.env['BASE_URL'] ?? 'http://127.0.0.1:15430';
const ADMIN = process.env['DEMO_ADMIN'] ?? 'admin@example.test';
const ADMIN_PASSWORD = process.env['DEMO_ADMIN_PASSWORD'] ?? 'admin-password-1';
const DEMO_PASSWORD = 'demo-password-123';

interface Step {
  readonly what: string;
  readonly why?: string;
  readonly command: string;
}

/** A step's shell, wrapped so it is readable at 80 columns and still runnable. */
const curl = (
  method: string,
  path: string,
  options: {
    body?: unknown;
    /** Already-quoted JSON, for a body a shell variable has to reach. */
    rawBody?: string;
    auth?: string;
    headers?: Record<string, string>;
    /** No `-i`: the body is about to be piped into a parser. */
    silent?: boolean;
    /** Headers only, for the step that wants the ETag. */
    head?: boolean;
  } = {},
): string => {
  // `-w '\n'` on the printing form: a response with no trailing newline runs
  // into the next line of the transcript, and the whole run reads as a wall.
  const flags =
    options.head === true
      ? '-sS -D - -o /dev/null'
      : options.silent === true
        ? '-sS'
        : `-sS -i -w '\\n'`;
  const lines = [`curl ${flags} -X ${method} "$BASE${path}"`];
  if (options.body !== undefined || options.rawBody !== undefined) {
    lines.push(`  -H 'content-type: application/json'`);
  }
  if (options.auth !== undefined) {
    lines.push(`  -H "authorization: Bearer ${options.auth}"`);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    // **Double quotes**, because these carry shell variables — `$ETAG` inside
    // single quotes is five literal characters, and the request that resulted
    // answered 412 forever while looking exactly right in the transcript. The
    // generator having the bug the generator exists to prevent is the reason
    // this file is run end to end rather than eyeballed.
    lines.push(`  -H "${name}: ${value}"`);
  }
  if (options.rawBody !== undefined) {
    // Already quoted by the caller — see the register step for why.
    lines.push(`  -d ${options.rawBody}`);
  } else if (options.body !== undefined) {
    lines.push(`  -d '${JSON.stringify(options.body)}'`);
  }
  return lines.join(' \\\n');
};

function steps(paths: ReadonlySet<string>): readonly Step[] {
  /** Print a step only if the server actually mounts the route. */
  const when = (route: string, step: Step): readonly Step[] =>
    paths.has(route) ? [step] : [];

  /** Capture a field out of a response body into a shell variable. */
  const capture = (name: string, field: string, request: string): string =>
    `${name}=$(${request} | ${read(field)})\necho "${name}=$${name}"`;

  return [
    ...when('POST /v1/sessions', {
      what: 'Log in as the administrator',
      why: '`make dev` seeds this account. $TOKEN is used by everything below.',
      command: capture(
        'TOKEN',
        'access_token',
        curl('POST', '/v1/sessions', {
          body: { email: ADMIN, password: ADMIN_PASSWORD },
          silent: true,
        }),
      ),
    }),
    ...when('GET /v1/me', {
      what: 'Who am I',
      command: curl('GET', '/v1/me', { auth: '$TOKEN' }),
    }),
    ...when('GET /v1/users', {
      what: 'The directory, one page at a time',
      why: 'Keyset pagination — the cursor is opaque and belongs to this filter.',
      command: curl('GET', '/v1/users?limit=3', { auth: '$TOKEN' }),
    }),
    ...when('GET /v1/users', {
      what: 'Search it',
      command: curl('GET', '/v1/users?q=ada&limit=3', { auth: '$TOKEN' }),
    }),
    ...when('POST /v1/users', {
      what: 'Register somebody new, and keep their id',
      why: 'Public: no credential. Roles are never accepted here — see below.',
      // **The address is built in the shell, not baked in.** `$RANDOM` inside
      // a single-quoted `-d` is four literal characters, so the second run of
      // this script got a 409 and every step after it read a variable that was
      // never set — which is exactly the *everything works and nothing tells
      // you how to start* failure this criterion exists to catch, arriving
      // inside the thing built to prevent it.
      command: [
        `NEW_EMAIL="newcomer-$RANDOM@example.test"`,
        capture(
          'USER_ID',
          'id',
          curl('POST', '/v1/users', {
            // Single-quote out, double-quote in: standard shell splicing, and
            // no backslashes to lose on the way through the generator.
            rawBody: `'{"email":"'"$NEW_EMAIL"'","password":"${DEMO_PASSWORD}","display_name":"A Newcomer"}'`,
            silent: true,
          }),
        ),
      ].join('\n'),
    }),
    ...when('GET /v1/users/:id', {
      what: 'Read them back, and keep the ETag',
      why: 'The ETag identifies this exact representation. The next step needs it.',
      command: `ETAG=$(${curl('GET', '/v1/users/$USER_ID', {
        auth: '$TOKEN',
        head: true,
      })} | grep -i '^etag:' | cut -d' ' -f2 | tr -d '\\r')\necho "ETAG=$ETAG"`,
    }),
    ...when('PATCH /v1/users/:id', {
      what: 'Suspend them',
      why: 'If-Match is REQUIRED: without it this is a lost update waiting to happen.',
      command: curl('PATCH', '/v1/users/$USER_ID', {
        auth: '$TOKEN',
        headers: { 'if-match': '$ETAG' },
        body: { status: 'disabled' },
      }),
    }),
    ...when('PATCH /v1/users/:id', {
      what: 'Try again with the SAME ETag — 412',
      why: 'The representation moved when you suspended them. This is the point of If-Match.',
      command: curl('PATCH', '/v1/users/$USER_ID', {
        auth: '$TOKEN',
        headers: { 'if-match': '$ETAG' },
        body: { status: 'active' },
      }),
    }),
    ...when('PATCH /v1/users/:id', {
      what: 'Re-read, then reinstate them',
      why: 'Read, decide, write — against the version you actually read.',
      command: `ETAG=$(${curl('GET', '/v1/users/$USER_ID', {
        auth: '$TOKEN',
        head: true,
      })} | grep -i '^etag:' | cut -d' ' -f2 | tr -d '\\r')\n${curl(
        'PATCH',
        '/v1/users/$USER_ID',
        {
          auth: '$TOKEN',
          headers: { 'if-match': '$ETAG' },
          body: { status: 'active' },
        },
      )}`,
    }),
    ...when('POST /v1/users/:id/roles', {
      what: 'Grant a role',
      why: 'Administrator only. The first administrator comes from `make seed`.',
      command: curl('POST', '/v1/users/$USER_ID/roles', {
        auth: '$TOKEN',
        body: { role: 'auditor' },
      }),
    }),
    ...when('GET /v1/audit', {
      what: 'Read what all of that did',
      why: 'Policy-scoped: an administrator sees everything, a member sees their own.',
      command: curl('GET', '/v1/audit?limit=5', { auth: '$TOKEN' }),
    }),
    ...when('DELETE /v1/sessions/current', {
      what: 'Log out',
      command: curl('DELETE', '/v1/sessions/current', { auth: '$TOKEN' }),
    }),
    ...when('GET /v1/me', {
      what: 'And the token stops working',
      command: curl('GET', '/v1/me', { auth: '$TOKEN' }),
    }),
  ];
}

/**
 * Read one field out of a JSON body.
 *
 * **No `jq`**: a starter kit whose first instruction is *install jq* has
 * already lost five of its five minutes. Python 3 ships with macOS and every
 * Linux this runs on.
 */
function read(field: string): string {
  return `python3 -c 'import sys,json;print(json.load(sys.stdin)["${field}"])'`;
}

export function render(paths: ReadonlySet<string>): string {
  const out: string[] = [
    '#!/usr/bin/env bash',
    '#',
    '# The journey, as runnable requests. GENERATED by `make curl` from the',
    '# route table the server mounts — do not edit, and do not paste a request',
    '# that is not in here, because it does not exist.',
    '#',
    '#   make dev                    # one terminal: boots, seeds, serves',
    '#   make curl > journey.sh      # another: this',
    '#   bash journey.sh             # and run it',
    '#',
    '# Everybody in the demo data logs in with the same password. The',
    '# administrator is the account `make seed` mints from configuration.',
    '#',
    'set -u',
    `BASE=\${BASE_URL:-${BASE}}`,
    '',
  ];

  for (const step of steps(paths)) {
    out.push(`# ── ${step.what}`);
    if (step.why !== undefined) out.push(`#    ${step.why}`);
    out.push(step.command, '');
  }
  return out.join('\n');
}

// Built with stub dependencies: nothing here calls a handler, and the route
// table is a value.
const { identityRoutes } =
  await import('../src/contexts/identity/transport/http/routes.js');
const { auditRoutes } =
  await import('../src/contexts/audit/transport/http/routes.js');

const mounted = new Set(
  [
    ...identityRoutes(
      { deps: {} as IdentityDeps },
      {
        defaultRoles: [],
      },
    ),
    ...auditRoutes({ caller: () => undefined } as never),
  ].map((route) => `${route.method} ${route.path}`),
);

process.stdout.write(render(mounted));
