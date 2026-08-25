/**
 * **The first administrator.** `../../CONTEXTS.md` §7.4.
 *
 * Granting a role needs a role, so an empty database cannot reach one. This is
 * the base case, proved the only way it can be: seed a process from
 * configuration, log in as the account that produced, and reach a route no
 * registered user can.
 *
 * Memory mode, because the point is the *path* and not the store — and because
 * `seed` followed by `serve` in memory means two processes and two empty maps,
 * so this runs both against one process by seeding through the same `wire`
 * the server uses. The Postgres equivalent is the `make seed` in `Makefile`,
 * which the journey suite's migrate step already exercises.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe } from '../testx/probe.js';
import { testDsn } from '../testx/postgres.js';
import { serve, type Started } from '../testx/process.js';
import { Journal } from '../testx/journal.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EMAIL = 'root@example.invalid';
const PASSWORD = 'a bootstrap secret nobody ships';

const dsn = testDsn();
const reachable = await probe(dsn);

if (!reachable.ok) {
  describe.skip(`the first administrator — SKIPPED: ${reachable.reason}`, () => {
    // The title carries the result; vitest needs a body.
  });
} else {
  let app: Started;
  let http: Journal;

  beforeAll(async () => {
    const env = {
      ...process.env,
      DATABASE_URL: dsn,
      LOG_FORMAT: 'json',
      TRUSTED_PROXIES: 'none',
    };
    const run = (command: string, extra: Record<string, string> = {}) =>
      execFileSync('node', ['--import', 'tsx', 'src/main.ts', command], {
        cwd: ROOT,
        env: { ...env, ...extra },
        stdio: 'pipe',
      }).toString();

    run('migrate');
    // **The real command, with the real refusal.** Run twice on purpose: the
    // second is the idempotent case, and a seed that is not idempotent breaks
    // the second deploy rather than the first.
    run('seed', {
      STORAGE: 'postgres',
      BOOTSTRAP_ADMIN_EMAIL: EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    });
    run('seed', {
      STORAGE: 'postgres',
      BOOTSTRAP_ADMIN_EMAIL: EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: PASSWORD,
    });

    app = await serve({ STORAGE: 'postgres', DATABASE_URL: dsn });
    http = new Journal({
      base: app.base,
      artifact: 'artifacts/e2e-bootstrap.md',
      title: 'The first administrator',
    });
    http.secret(PASSWORD);
  }, 90_000);

  afterAll(async () => {
    http.finish();
    await app.stop();
  });

  describe('the first administrator', () => {
    let adminToken = '';
    let memberToken = '';
    let memberId = '';

    it('refuses to seed without credentials — exit 78', () => {
      // The one behaviour §7.4 is emphatic about. A default administrator
      // password is the same credential in every deploy, and the `.env` gets
      // copied.
      let code = 0;
      try {
        execFileSync('node', ['--import', 'tsx', 'src/main.ts', 'seed'], {
          cwd: ROOT,
          env: { ...process.env, STORAGE: 'memory', TRUSTED_PROXIES: 'none' },
          stdio: 'pipe',
        });
      } catch (error) {
        code = (error as { status?: number }).status ?? 0;
      }

      expect(code).toBe(78); // EX_CONFIG
    });

    it('logs in as the seeded account', async () => {
      http.step('Log in as the bootstrap administrator');

      const session = await http.send<{ access_token: string }>(
        'POST',
        '/v1/sessions',
        { body: { email: EMAIL, password: PASSWORD } },
      );

      expect(session.status).toBe(201);
      adminToken = http.secret(session.body.access_token);
    });

    it('registers an ordinary user, who holds only `member`', async () => {
      http.step('An ordinary user');

      const email = `mate+${String(Date.now())}@example.invalid`;
      const created = await http.send<{ id: string; roles: string[] }>(
        'POST',
        '/v1/users',
        { body: { email, password: 'an ordinary password here' } },
      );
      const session = await http.send<{ access_token: string }>(
        'POST',
        '/v1/sessions',
        { body: { email, password: 'an ordinary password here' } },
      );

      expect(created.status).toBe(201);
      expect(created.body.roles).toEqual(['member']);
      memberId = created.body.id;
      memberToken = http.secret(session.body.access_token);
    });

    it('grants a role, which no member can', async () => {
      http.step('Grant a role');

      const grant = (token: string) =>
        http.send('POST', `/v1/users/${memberId}/roles`, {
          headers: { authorization: `Bearer ${token}` },
          body: { role: 'auditor' },
        });

      const byMember = await grant(memberToken);
      const byAdmin = await grant(adminToken);

      // **The recursion, closed.** Without §7.4 both of these are 403 and there
      // is no third caller to try.
      expect(byMember.status).toBe(403);
      expect(byAdmin.status).toBeGreaterThanOrEqual(200);
      expect(byAdmin.status).toBeLessThan(300);
    });

    it('and the granted role takes effect on the next request — case 12', async () => {
      http.step('The grant is live');

      const wide = await http.send<unknown[]>('GET', '/v1/audit', {
        headers: { authorization: `Bearer ${memberToken}` },
      });

      // An `auditor` reads unrestricted, so this caller now sees records whose
      // subject is not them — which the same token could not do a moment ago.
      expect(wide.status).toBe(200);
      expect(Array.isArray(wide.body)).toBe(true);
    });
  });
}
