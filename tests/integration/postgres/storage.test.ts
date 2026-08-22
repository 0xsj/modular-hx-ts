/**
 * The storage-behaviour suite, against a real PostgreSQL. **Rung 2.**
 *
 * One adapter today. `../../../MODULES.md` §3 nominates this repository for the
 * two-adapters-under-one-repository-port experiment, and when the second query
 * layer lands this file gains a second `storageBehaviour(...)` call and nothing
 * else — which is the point of the suite taking its subject as a parameter.
 */

import { afterAll, beforeAll } from 'vitest';
import { storageBehaviour } from '../../../src/shared/postgres/storage.contract.js';
import { integration } from '../../testx/gate.js';
import { withSchema, type Schema } from '../../testx/postgres.js';

let schema: Schema;

integration('storage behaviour', () => {
  beforeAll(async () => {
    schema = await withSchema();
  });

  afterAll(async () => {
    await schema.close();
  });

  storageBehaviour(() => ({ db: schema.db, name: 'pg' }));
});
