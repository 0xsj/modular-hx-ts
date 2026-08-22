/**
 * PostgreSQL. **L2 substrate — and the layer's one exception.**
 *
 * `../../../MODULES.md` §3: every other module here has a port, a memory
 * adapter, a real adapter and one contract suite both pass. **`postgres` has
 * none of that, deliberately.** It is not a port with two implementations — it
 * is what the real implementations are *built on*, and its memory counterpart
 * does not exist because a memory repository simply does not use it.
 * `STORAGE=memory` never reaches this module. Rule `M1` therefore applies to
 * the repositories above it, never here, and **there is no fake pool**.
 *
 * Two interfaces do the swapping, and this module is neither of them:
 *
 * - **`DB`** — what a *repository* depends on. Declared here, satisfied by both
 *   the pool and a transaction, and named in terms of SQL and parameters so
 *   that changing the query layer changes no repository signature.
 * - **`Transactor`** — what a *use case* depends on. **Not declared here**, on
 *   purpose: it is consumer-declared in `app/`, because an application layer
 *   that imported `postgres` to say "these writes are atomic" would have
 *   inverted nothing. `withinTx` satisfies it without this module naming it.
 *
 * `Config`, the pool and `migrate` are none of the above: a struct, a concrete
 * thing, and a tool the composition root runs.
 *
 * Note: `notes/patterns/postgres.md`.
 */

export { type DB, type Row } from './db.js';

export {
  type Config,
  type Guardrails,
  DEFAULTS,
  dsnWithGuardrails,
  guardrails,
} from './config.js';

export { type Postgres, connect, dbOver } from './pool.js';

export { kindForSqlState, sqlStateOf, asAppError } from './sqlstate.js';

export {
  type Applied,
  type Migration,
  type MigrationSet,
  type Report,
  checksum,
  migrate,
} from './migrate.js';
