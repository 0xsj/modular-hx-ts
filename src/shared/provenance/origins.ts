/**
 * Where provenance comes from. **L1 runtime.**
 *
 * `../../../PROVENANCE.md` §4: **every unit of work has provenance.** Optional
 * everywhere was rejected because it reduces rule `M5` to checking that a
 * struct exists rather than that its fields do, and turns *"one gap
 * disconnects both graphs"* from a warning into the behaviour.
 *
 * Five origins mint. The sixth — a subscriber — **derives**, and does not live
 * here: its cause is the event id, so it is `p.derive(env.id)`, and the
 * envelope-shaped convenience belongs to `events` at L2 because `provenance`
 * is L1 and rule `S1` forbids the import permanently.
 *
 * See `notes/patterns/provenance.md`.
 */

import { invariant } from '../assert/index.js';
import { type IdGenerator } from '../id/index.js';
import { Actor } from './actor.js';
import { isProvenanceId, isTraceparent } from './ids.js';
import { createProvenance, type Provenance } from './provenance.js';

/**
 * What an inbound request offers.
 *
 * Only the three fields §5 permits adopting. `request_id`, `actor` and `tenant`
 * are absent from this type on purpose — a caller cannot supply them, so there
 * is nothing for a middleware author to be tempted by.
 */
export interface InboundHeaders {
  readonly correlationId?: string | undefined;
  readonly causationId?: string | undefined;
  readonly traceparent?: string | undefined;
}

/**
 * Take an adopted value, or nothing.
 *
 * **An invalid value is dropped, never a request failure.** Provenance grants
 * nothing, so strictness is free: the worst case of rejecting a malformed
 * correlation id is a broken trace link, and the worst case of accepting one is
 * log injection.
 */
function adopt(
  value: string | undefined,
  acceptable: (candidate: string) => boolean,
): string | undefined {
  return value !== undefined && acceptable(value) ? value : undefined;
}

/** A system actor, or a bug. A malformed path is never user input. */
function systemActor(path: string): Actor {
  const actor = Actor.system(path);
  invariant(actor.ok, `system actor path is valid: ${path}`);
  return actor.value;
}

export interface Origins {
  /**
   * An inbound request.
   *
   * The request id is **always minted** — a caller-supplied one lets two
   * requests share an identity, which breaks idempotency reasoning and audit
   * uniqueness. Correlation is adopted when it is well-formed, and otherwise
   * falls back to this request's own id, which makes a root request the root of
   * its own chain.
   *
   * The actor starts `anonymous:` and is replaced by the authenticator once
   * credentials verify. Adopting one from a header is an authentication bypass.
   */
  forRequest(inbound?: InboundHeaders): Provenance;

  /** A scheduled job. Actor `system:jobs/<name>`. */
  forJob(name: string): Provenance;

  /** A migration run. Actor `system:migrate`. */
  forMigration(): Provenance;

  /** Process start-up. Actor `system:boot`. */
  forBoot(): Provenance;

  /** A command-line invocation. Actor `system:cli/<command>`. */
  forCli(command: string): Provenance;
}

/**
 * Bind the origins to an id source.
 *
 * `provenance` mints through the `id` port — L1 importing L0, which rule `S1`
 * permits. The minted value is a UUIDv7, but adopted values stay **opaque
 * strings**: you cannot require an upstream service to emit UUIDv7, and typing
 * these as ids would make adopting a peer's correlation id impossible.
 */
export function makeOrigins(ids: IdGenerator): Origins {
  const mint = (): string => ids.uuid();

  /** Everything that is not a request: its own root, no cause, a system actor. */
  const rootedAt = (path: string): Provenance => {
    const requestId = mint();

    return createProvenance({
      requestId,
      // Its own root. A job is not caused by anything that came before it.
      correlationId: requestId,
      causationId: undefined,
      actor: systemActor(path),
      tenant: undefined,
      traceparent: undefined,
      mint,
    });
  };

  return {
    forRequest: (inbound = {}) => {
      const requestId = mint();

      return createProvenance({
        requestId,
        correlationId:
          adopt(inbound.correlationId, isProvenanceId) ?? requestId,
        causationId: adopt(inbound.causationId, isProvenanceId),
        actor: Actor.anonymous(),
        tenant: undefined,
        traceparent: adopt(inbound.traceparent, isTraceparent),
        mint,
      });
    },

    forJob: (name) => rootedAt(`jobs/${name}`),
    forMigration: () => rootedAt('migrate'),
    forBoot: () => rootedAt('boot'),
    forCli: (command) => rootedAt(`cli/${command}`),
  };
}
