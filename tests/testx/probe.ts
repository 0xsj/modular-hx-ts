/**
 * Is there a database to integrate against?
 *
 * Separated from the gate so `global-setup.ts` can run it in the main process
 * without importing `vitest`'s test-scoped API.
 */

import pg from 'pg';

export type Reachability =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** `host:port/database` — never the credentials, since a report gets pasted. */
function where(dsn: string): string {
  try {
    const url = new URL(dsn);
    return `${url.hostname}:${url.port}${url.pathname}`;
  } catch {
    return 'the configured database';
  }
}

/**
 * A short connect timeout on purpose: the case being measured is the one where
 * nothing answers, and that is the case that must not cost anybody a minute.
 */
export async function probe(dsn: string): Promise<Reachability> {
  const pool = new pg.Pool({
    connectionString: dsn,
    max: 1,
    connectionTimeoutMillis: 2_000,
  });
  // A pool with no error listener throws when a backend dies, which is what a
  // refused connection can look like on the way out.
  pool.on('error', () => undefined);

  try {
    await pool.query('select 1');
    return { ok: true };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const detail =
      typeof code === 'string'
        ? code
        : error instanceof Error
          ? error.message
          : String(error);

    return {
      ok: false,
      reason: `no database at ${where(dsn)} (${detail}) — run \`make infra-up\``,
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
