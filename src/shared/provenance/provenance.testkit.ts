/**
 * A builder for tests. **Test tooling** — rule `S3` keeps it out of shipping
 * code, and `tsconfig.build.json` keeps it out of `dist`.
 *
 * `../../../PROVENANCE.md` §4 closes construction deliberately: fields are
 * private and every route in mints or derives, so a child cannot inherit its
 * parent's request id. That is right for application code and needlessly
 * painful in a test that wants one specific field to differ.
 *
 * This is the same shape as `fakeClock` and `fakeIds`: inline construction
 * stays easy where it is harmless, and impossible where it is not.
 */

import { Actor } from './actor.js';
import { createProvenance, type Provenance } from './provenance.js';

export interface FakeProvenanceOptions {
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly actor?: Actor;
  readonly tenant?: string;
  readonly traceparent?: string;
}

/**
 * Provenance with everything defaulted and anything overridable.
 *
 * The defaults are fixed rather than random, so a test that asserts on a
 * request id does not depend on the run.
 */
export function fakeProvenance(
  options: FakeProvenanceOptions = {},
): Provenance {
  let counter = 0;
  const mint = (): string => `req_${String(++counter).padStart(3, '0')}`;

  const requestId = options.requestId ?? 'req_000';

  return createProvenance({
    requestId,
    // Matching an origin's behaviour: with nothing adopted, a root request is
    // the root of its own chain.
    correlationId: options.correlationId ?? requestId,
    causationId: options.causationId,
    actor: options.actor ?? Actor.anonymous(),
    tenant: options.tenant,
    traceparent: options.traceparent,
    mint,
  });
}
