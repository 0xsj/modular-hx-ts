/**
 * The audit record. **`audit` domain.**
 *
 * **Everything here arrived on an event.** This context imports no other, so
 * nothing in a record can be looked up — and that constraint is what makes the
 * shape what it is. `subject` is a bare id because `audit` cannot resolve it
 * into a name, and if a reader ever needs the name then the *event* is wrong.
 *
 * **Append-only.** There is no mutation on this type and no `save`, because a
 * record that can be edited is not an audit record. The nearest thing to a
 * correction is a second record saying so.
 *
 * See `notes/domain/audit.md`.
 */

import { invalid } from '../../../shared/errors/index.js';

declare const tag: unique symbol;
export type RecordId = string & { readonly [tag]: 'RecordId' };
export const recordId = (value: string): RecordId => value as RecordId;

/**
 * The stored shape.
 *
 * **Absent fields are `undefined`, never `null`** — `PROVENANCE.md` §6, and
 * conformance case 38a: *the same logical record canonicalizes to identical
 * bytes in every language, including when `causation_id` and `tenant` are
 * absent.* A `null` and an omission are different documents under RFC 8785, so
 * a language that emits one where another omits produces a different digest for
 * the same fact.
 */
export interface AuditRecordState {
  readonly id: RecordId;
  /**
   * The **event's** id, not this record's.
   *
   * Unique — conformance case 36. Delivery is at-least-once, so a redelivery
   * must add no row, and the constraint is what makes that true under
   * concurrency rather than a read-then-insert that races itself.
   */
  readonly eventId: string;
  /** `<context>.<aggregate>.<past-tense-verb>` — §2.5. */
  readonly event: string;
  /** Who acted. `kind:id`, from the envelope's provenance. */
  readonly actor: string;
  /**
   * What was acted upon, from the event's own payload.
   *
   * **Not derived from the actor**, and the difference is the whole reason §2.5
   * puts it on the payload: an administrator disabling somebody else, a
   * challenge consumed on behalf of a user, a job expiring a session. A record
   * that assumes they are equal is wrong exactly when it matters.
   */
  readonly subject?: string | undefined;
  readonly requestId: string;
  /** Case 38: **X's** correlation id, not one this subscriber minted. */
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly tenant?: string | undefined;
  readonly traceparent?: string | undefined;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
}

export class AuditRecord {
  readonly state: AuditRecordState;

  private constructor(state: AuditRecordState) {
    this.state = state;
  }

  static of(state: AuditRecordState): AuditRecord {
    if (state.eventId === '' || state.event === '' || state.actor === '') {
      // A record missing any of these is unattributable, and an unattributable
      // audit record is worse than none: it looks like evidence.
      throw invalid('an audit record needs an event id, a name and an actor');
    }
    return new AuditRecord(state);
  }

  get id(): RecordId {
    return this.state.id;
  }
  get eventId(): string {
    return this.state.eventId;
  }

  /**
   * The canonical wire form — conformance case 38a.
   *
   * **Snake case and absent-means-omitted**, matching `ProvenanceWire` and the
   * envelope, so a record digested here and a record digested in Go produce the
   * same bytes. `Date` becomes an ISO-8601 string with a `Z`, because a
   * `Date` serializes three different ways depending on who asks.
   *
   * Not a view for the API — that is `transport/`'s. This is the form a digest
   * is taken over and the form a cross-language fixture would compare.
   */
  toWire(): Readonly<Record<string, string>> {
    const { state } = this;
    return {
      id: state.id,
      event_id: state.eventId,
      event: state.event,
      actor: state.actor,
      ...(state.subject === undefined ? {} : { subject: state.subject }),
      request_id: state.requestId,
      correlation_id: state.correlationId,
      ...(state.causationId === undefined
        ? {}
        : { causation_id: state.causationId }),
      ...(state.tenant === undefined ? {} : { tenant: state.tenant }),
      ...(state.traceparent === undefined
        ? {}
        : { traceparent: state.traceparent }),
      occurred_at: state.occurredAt.toISOString(),
      recorded_at: state.recordedAt.toISOString(),
    };
  }
}
