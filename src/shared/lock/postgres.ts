/**
 * PostgreSQL advisory locks. **The real adapter.**
 *
 * Chosen for one property above all: **a crashed holder releases
 * automatically.** The lock lives on the connection, so when the holder dies —
 * `SIGKILL`, an OOM, a severed network — the backend goes with it and the lock
 * is free. Nothing has to notice, nothing has to sweep, and there is no window
 * in which a dead instance still owns the fleet's singleton.
 *
 * **Session-scoped, not transaction-scoped.** `pg_try_advisory_lock` holds
 * until released or the session ends; `pg_try_advisory_xact_lock` releases at
 * the end of the *transaction*, which for a job that runs for a minute means
 * the lock is gone before the work is. The migrator wants the transaction-scoped
 * one and this wants the session-scoped one, for the same reason from opposite
 * ends.
 *
 * **Rejected: a row in a table with a TTL.** It needs a sweeper, the TTL is a
 * guess about how long a healthy holder pauses, and a holder that dies keeps
 * its lock until the TTL expires — which is precisely the window advisory locks
 * do not have.
 *
 * See `notes/patterns/lock.md`.
 */

import { type Postgres, type Session } from '../postgres/index.js';
import { advisoryKey } from './key.js';
import { type Lease, type Locks } from './port.js';

export function postgresLocks(db: Postgres, namespace: string): Locks {
  /**
   * Every lease holds its **own** connection for its whole life.
   *
   * This is the part that is easy to get wrong: an advisory lock belongs to the
   * session that took it. Taking one on a pooled connection and returning the
   * connection would leave the lock held by whoever borrows it next, and
   * releasing from a *different* pooled connection is a silent no-op — Postgres
   * warns and returns false rather than erroring.
   */
  const outstanding = new Set<Session>();

  return {
    async tryAcquire(name: string) {
      const key = advisoryKey(namespace, name);
      const client = await db.session();

      let got: boolean;
      try {
        const row = await client.queryRow<{ locked: boolean }>(
          'select pg_try_advisory_lock($1) as locked',
          [key.toString()],
        );
        got = row?.locked === true;
      } catch (error) {
        client.release(true);
        throw error;
      }

      if (!got) {
        // Somebody else holds it. Give the connection straight back — holding
        // one per failed attempt is how a contended period exhausts the pool.
        client.release();
        return undefined;
      }

      outstanding.add(client);
      let released = false;

      return {
        name,
        release: async () => {
          if (released) return;
          released = true;
          outstanding.delete(client);

          try {
            await client.exec('select pg_advisory_unlock($1)', [
              key.toString(),
            ]);
            client.release();
          } catch {
            // If the unlock failed the session is in an unknown state, and a
            // session returned to the pool still holding a lock is worse than a
            // discarded connection. Destroying it ends the session, which
            // releases the lock by the same mechanism a crash would.
            client.release(true);
          }
        },
      } satisfies Lease;
    },

    async withLock<T>(name: string, fn: () => Promise<T> | T) {
      const lease = await this.tryAcquire(name);
      if (lease === undefined) return undefined;

      try {
        return await fn();
      } finally {
        await lease.release();
      }
    },

    releaseAll() {
      // Destroying each connection ends its session and releases whatever it
      // held — the same path a crash takes, which is why it needs no bookkeeping
      // of which keys are outstanding.
      for (const client of [...outstanding]) {
        outstanding.delete(client);
        client.release(true);
      }
      return Promise.resolve();
    },
  };
}
