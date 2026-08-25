/**
 * The subscriber. **`audit` app · subscriber — the first in this repository.**
 *
 * Subscribes to **every** context's events and records who did what, to which
 * subject, when, in which request and trace.
 *
 * **It imports no context, and that is the constraint rather than a detail.**
 * Everything recorded arrives on the envelope: the actor from its provenance,
 * the subject from the event's own payload. There is nothing here that resolves
 * an id into a name, and if a reader ever needs one, **the event is wrong** and
 * the fix belongs there.
 *
 * See `notes/domain/audit.md`.
 */

import { type Clock } from '../../../../shared/clock/index.js';
import {
  type Envelope,
  type Subscription,
  EVERYTHING,
  provenanceFor,
} from '../../../../shared/events/index.js';
import { type IdGenerator } from '../../../../shared/id/index.js';
import { AuditRecord, recordId } from '../../domain/index.js';
import { type AuditLog } from '../ports.js';

export interface SubscriberDeps {
  readonly log: AuditLog;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * **Every event, from every context.**
 *
 * `*` rather than an enumeration, and it is the honest pattern: `audit` records
 * what happened, and a list of names here would silently stop recording the
 * next context's events until somebody remembered to add them. The failure mode
 * of a missing subscription is a gap in the log that nothing reports.
 */
export const AUDIT_PATTERN = EVERYTHING;

/** Stable, because at-least-once delivery dedupes per subscriber name. */
export const AUDIT_SUBSCRIBER = 'audit';

/**
 * The subject, from the event's own payload.
 *
 * §2.5 requires it there precisely because `audit` cannot look anything up.
 * Absent is legal and recorded as absent rather than guessed — an event about
 * no particular subject exists, and filling the field with the actor would
 * make every such record a false claim about who was acted upon.
 */
function subjectOf(envelope: Envelope): string | undefined {
  const value = envelope.payload['subject'];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function auditSubscriber(deps: SubscriberDeps): Subscription {
  return {
    pattern: AUDIT_PATTERN,
    name: AUDIT_SUBSCRIBER,

    async handle(envelope: Envelope): Promise<void> {
      // **Derived, never minted** — conformance case 38 and `PROVENANCE.md` §4.
      //
      // `provenanceFor` is `envelope.provenance.derive(envelope.id)`: a new
      // request id for this unit of work, the **envelope's** correlation id
      // carried through, and the envelope's id as the cause. A subscriber that
      // called `forJob` or `forRequest` would mint a fresh correlation and
      // break the chain at exactly the point `audit` exists to record — the
      // record would say *something happened* with no way back to the request
      // that caused it.
      const provenance = provenanceFor(envelope);
      const source = envelope.provenance;

      const record = AuditRecord.of({
        id: recordId(deps.ids.uuid()),
        eventId: envelope.id,
        event: envelope.name,
        // **The actor from the envelope**, never re-derived. §2.5: it rides the
        // provenance, and a subscriber that recomputed it would be inventing
        // one for a request it never saw.
        actor: source.actor.toString(),
        ...(subjectOf(envelope) === undefined
          ? {}
          : { subject: subjectOf(envelope) }),
        // The originating request, not this unit of work's.
        requestId: source.requestId,
        correlationId: provenance.correlationId,
        ...(source.causationId === undefined
          ? {}
          : { causationId: source.causationId }),
        ...(source.tenant === undefined ? {} : { tenant: source.tenant }),
        ...(source.traceparent === undefined
          ? {}
          : { traceparent: source.traceparent }),
        occurredAt: envelope.occurredAt,
        recordedAt: deps.clock.now(),
      });

      // The return is deliberately ignored here and deliberately *returned* by
      // the port: a redelivery is normal traffic, and the caller that wants to
      // count it is a test.
      await deps.log.append(record);
    },
  };
}
