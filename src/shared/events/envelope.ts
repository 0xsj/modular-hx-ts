/**
 * The envelope, and the one constructor that makes rule `M5` enforceable.
 * **L2 substrate.**
 *
 * `../../../ENFORCEMENT.md` `M5`: *every published envelope carries request,
 * correlation, causation, actor and tenant.* Its **Detect** clause is the whole
 * design here — *publish goes through the envelope constructor, which requires
 * them; flag direct construction outside the events module.*
 *
 * That is why `Provenance` is a **required parameter** rather than an optional
 * field filled in later or read from the ambient carrier. *"Publish goes
 * through a constructor that requires provenance"* is checkable;
 * *"hopefully the context had it"* is not, and
 * `../../../PROVENANCE.md` §3 says the same in one line: anything producing an
 * artifact that outlives the request takes provenance **explicitly**.
 *
 * See `notes/patterns/events.md`.
 */

import { invariant } from '../assert/index.js';
import { internal } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { type Uuid } from '../id/index.js';
import { Provenance, type ProvenanceWire } from '../provenance/index.js';
import { type Event, type Payload } from './event.js';

export interface EnvelopeWire {
  readonly id: string;
  readonly name: string;
  readonly occurred_at: string;
  readonly payload: Payload;
  readonly provenance: ProvenanceWire;
}

/**
 * An event, stamped and ready to travel.
 *
 * Fields are `#private` and construction goes through `seal`, for the reason
 * `../../../PROVENANCE.md` §4 gives about provenance itself: an envelope that
 * can be built field-by-field is one that can be built without provenance, and
 * `M5` stops being detectable.
 */
export class Envelope {
  readonly #id: Uuid;
  readonly #name: string;
  readonly #occurredAt: Date;
  readonly #payload: Payload;
  readonly #provenance: Provenance;

  private constructor(
    id: Uuid,
    name: string,
    occurredAt: Date,
    payload: Payload,
    provenance: Provenance,
  ) {
    this.#id = id;
    this.#name = name;
    this.#occurredAt = occurredAt;
    this.#payload = payload;
    this.#provenance = provenance;
  }

  /**
   * Seal an event into an envelope.
   *
   * **Provenance is required.** There is no overload without it, and that
   * absence is rule `M5`.
   */
  static seal(
    event: Event,
    provenance: Provenance,
    id: Uuid,
    occurredAt: Date,
  ): Envelope {
    // Not a type-system formality: `M5`'s detect clause is *"publish goes
    // through the envelope constructor, which requires them"*, and a caller
    // reaching this from untyped JavaScript is exactly the case a type cannot
    // stop.
    invariant(Provenance.is(provenance), 'an envelope carries provenance (M5)');
    return new Envelope(id, event.name, occurredAt, event.payload, provenance);
  }

  get id(): Uuid {
    return this.#id;
  }

  get name(): string {
    return this.#name;
  }

  /** When the thing happened — not when it was published or dispatched. */
  get occurredAt(): Date {
    return this.#occurredAt;
  }

  get payload(): Payload {
    return this.#payload;
  }

  get provenance(): Provenance {
    return this.#provenance;
  }

  /**
   * The canonical object form.
   *
   * `toJSON` deliberately, exactly as `Provenance` does it: fields are private,
   * so this is the only route to JSON and an accidental `JSON.stringify`
   * produces the right bytes rather than `{}`.
   */
  toJSON(): EnvelopeWire {
    return {
      id: this.#id,
      name: this.#name,
      occurred_at: this.#occurredAt.toISOString(),
      payload: this.#payload,
      provenance: this.#provenance.toJSON(),
    };
  }

  /**
   * Reconstruct one that was stored or transmitted.
   *
   * Takes `mint` because a reconstructed envelope must still be able to
   * **derive** — a subscriber reading a row out of the outbox needs a fresh
   * request id, and provenance carries no id source of its own. A `Result`
   * because the bytes came from outside this process: a row written by an older
   * version, or a broker message from anywhere, is untrusted input.
   */
  static fromWire(wire: EnvelopeWire, mint: () => string): Result<Envelope> {
    const provenance = Provenance.fromWire(mint, wire.provenance);
    if (!provenance.ok) return err(provenance.error);

    const occurredAt = new Date(wire.occurred_at);
    if (Number.isNaN(occurredAt.getTime())) {
      return err(internal(`${wire.id}: occurred_at is not a date`));
    }

    return ok(
      new Envelope(
        wire.id as Uuid,
        wire.name,
        occurredAt,
        wire.payload,
        provenance.value,
      ),
    );
  }
}

/**
 * Provenance for handling this envelope. **The subscriber rule, in one line.**
 *
 * `../../../PROVENANCE.md` §4: a subscriber **derives, it never mints**. It
 * takes correlation from the envelope, causation from **the event id**, and a
 * fresh request id — which is exactly `provenance.derive(cause)`.
 *
 * If a subscriber mints instead, the causal chain breaks at every context
 * boundary and the audit and lineage graphs disconnect. That is conformance
 * case 38 and the failure invariant `I6` exists to prevent.
 *
 * **Why this convenience lives here and not in `provenance`:** `provenance` is
 * L1 and `events` is L2, so it cannot import an envelope — `S1` forbids it
 * permanently. §4 also argues it is the better shape regardless: a broker
 * consumer, a `work` task and a webhook redelivery all derive from *parent plus
 * cause*, and an envelope is one carrier of that rather than the shape of the
 * operation.
 */
export function provenanceFor(envelope: Envelope): Provenance {
  return envelope.provenance.derive(envelope.id);
}
