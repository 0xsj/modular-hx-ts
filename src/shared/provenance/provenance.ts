/**
 * The record that answers "who caused this, and what caused that." **L1.**
 *
 * `../../../PROVENANCE.md` §2 fixes the shape and §4 makes it **immutable with
 * closed construction**. That is not style: §6 requires absent fields be
 * omitted rather than serialized as `null`, and §7 requires `traceparent` be
 * excluded from anything hashed or signed. Neither is achievable with default
 * marshaling, so custom serialization was required anyway — private fields
 * simply make it the *only* path, which turns a discipline into a guarantee.
 *
 * Nothing branches on provenance. It is metadata stamped onto records, never a
 * decision input, which is why its carriage rules differ from `authz`'s.
 *
 * See `notes/patterns/provenance.md`.
 */

import { internal } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { Actor, type ActorWire } from './actor.js';
import { isProvenanceId } from './ids.js';

/**
 * The of-record subset (§7): durable, hashed, signed.
 *
 * `traceparent` is deliberately absent. It changes per trace, so including it
 * would give the same logical action a different digest every time —
 * destroying deduplication and making a content digest useless as an
 * idempotency key.
 *
 * Snake_case because these exact keys are what gets canonicalized.
 */
export interface ProvenanceWire {
  readonly request_id: string;
  readonly correlation_id: string;
  readonly causation_id?: string;
  readonly actor: ActorWire;
  readonly tenant?: string;
}

/**
 * Internal construction shape. Every field required, `undefined` permitted —
 * which sidesteps `exactOptionalPropertyTypes` friction inside the class while
 * the public wire type keeps its optional keys.
 */
interface Fields {
  readonly requestId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly actor: Actor;
  readonly tenant: string | undefined;
  readonly traceparent: string | undefined;

  /**
   * How a child gets its request id.
   *
   * A capability, not data: it is excluded from the canonical form and from
   * equality. It travels with the value so `derive()` works wherever the
   * provenance ended up — including in a subscriber, which reconstructs one
   * from an envelope and immediately derives from it.
   */
  readonly mint: () => string;
}

class ProvenanceValue {
  readonly #fields: Fields;

  constructor(fields: Fields) {
    this.#fields = fields;
  }

  /** This inbound call. Minted here, never adopted (§5). */
  get requestId(): string {
    return this.#fields.requestId;
  }

  /** The chain's root. Survives every async hop. */
  get correlationId(): string {
    return this.#fields.correlationId;
  }

  /** What directly caused this unit of work. Absent at the root of a chain. */
  get causationId(): string | undefined {
    return this.#fields.causationId;
  }

  get actor(): Actor {
    return this.#fields.actor;
  }

  /** Null until the L3 resolver runs. L1 does not decide policy (§9). */
  get tenant(): string | undefined {
    return this.#fields.tenant;
  }

  /** Observability only. Never hashed, never signed (§7). */
  get traceparent(): string | undefined {
    return this.#fields.traceparent;
  }

  /**
   * A child of this unit of work.
   *
   * **The only way to get one.** Hand-building a child is how a parent's
   * request id ends up as the child's, which collapses the causal graph into a
   * self-loop — so no constructor permits it.
   *
   * Correlation, actor and tenant are inherited; the request id is new; and
   * causation is `causedBy` when given, otherwise this unit's request id.
   *
   * `causedBy` exists because a subscriber's cause is the **event id**, not the
   * publishing request. `provenance` is L1 and `events` is L2, so the
   * envelope-shaped convenience lives there, one line:
   * `events.provenanceFor(env) = env.provenance.derive(env.id)`.
   */
  derive(causedBy?: string): Provenance {
    return new ProvenanceValue({
      ...this.#fields,
      requestId: this.#fields.mint(),
      causationId: causedBy ?? this.#fields.requestId,
    });
  }

  /**
   * The same unit of work, now attributed.
   *
   * Set only by the authenticator, after credentials verify — an actor is never
   * adopted from a header, because adopting one is an authentication bypass.
   */
  withActor(actor: Actor): Provenance {
    return new ProvenanceValue({ ...this.#fields, actor });
  }

  /**
   * The same unit of work, now scoped.
   *
   * Set by the L3 tenant resolver after it checks the registry. The inbound
   * header is an *input to resolution*, never the value.
   */
  withTenant(tenant: string): Provenance {
    return new ProvenanceValue({ ...this.#fields, tenant });
  }

  /** Observability only, so this is set from an adopted header and nowhere else. */
  withTraceparent(traceparent: string): Provenance {
    return new ProvenanceValue({ ...this.#fields, traceparent });
  }

  /**
   * The of-record form (§7).
   *
   * On `toJSON` deliberately: fields are private, so this is the only route to
   * JSON, and a careless `JSON.stringify` yields the signed-safe bytes rather
   * than `{}` or a document containing `traceparent`.
   *
   * `causation_id` and `tenant` are **omitted when absent, never `null`** —
   * under RFC 8785 those are different documents with different digests, and
   * that divergence between languages is silent.
   */
  toJSON(): ProvenanceWire {
    const { requestId, correlationId, causationId, actor, tenant } =
      this.#fields;

    return {
      request_id: requestId,
      correlation_id: correlationId,
      ...(causationId === undefined ? {} : { causation_id: causationId }),
      actor: actor.toJSON(),
      ...(tenant === undefined ? {} : { tenant }),
    };
  }

  /** Equality over the of-record form. The id source is not part of the value. */
  equals(other: Provenance): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }
}

export type Provenance = ProvenanceValue;

/**
 * Build one from parts.
 *
 * **Internal to this module.** `index.ts` does not re-export it, and rule `S2`
 * makes the module root the only importable surface — which is how TypeScript
 * gets the boundary Go gets from an unexported constructor. Application code
 * reaches provenance through the origins in `origins.ts`, every one of which
 * mints or derives.
 */
export function createProvenance(fields: Fields): Provenance {
  return new ProvenanceValue(fields);
}

/**
 * Read one back from storage — an audit row, a stored envelope.
 *
 * Untrusted input, so it validates and returns a `Result`. The id source is
 * supplied because a reconstructed provenance must still be able to `derive`:
 * that is exactly what a subscriber does with an envelope's provenance.
 */
function fromWire(mint: () => string, wire: unknown): Result<Provenance> {
  if (typeof wire !== 'object' || wire === null) {
    return err(internal('provenance is not an object'));
  }

  const candidate = wire as Partial<Record<keyof ProvenanceWire, unknown>>;
  const requestId = candidate.request_id;
  const correlationId = candidate.correlation_id;
  const causationId = candidate.causation_id;
  const tenant = candidate.tenant;
  const rawActor = candidate.actor;

  if (typeof requestId !== 'string' || !isProvenanceId(requestId)) {
    return err(internal('provenance has no valid request_id'));
  }
  if (typeof correlationId !== 'string' || !isProvenanceId(correlationId)) {
    return err(internal('provenance has no valid correlation_id'));
  }
  if (
    causationId !== undefined &&
    (typeof causationId !== 'string' || !isProvenanceId(causationId))
  ) {
    return err(internal('provenance has an invalid causation_id'));
  }
  if (tenant !== undefined && typeof tenant !== 'string') {
    return err(internal('provenance has an invalid tenant'));
  }
  // Through the wire object, not the `kind:id` string: `on_behalf_of` is part
  // of the canonical form, and reconstructing via the string form would drop
  // the second principal.
  const actor = Actor.fromWire(rawActor);
  if (!actor.ok) return err(internal('provenance has an invalid actor'));

  return ok(
    createProvenance({
      requestId,
      correlationId,
      causationId,
      actor: actor.value,
      tenant,
      traceparent: undefined,
      mint,
    }),
  );
}

export const Provenance = {
  fromWire,

  is(value: unknown): value is Provenance {
    return value instanceof ProvenanceValue;
  },
} as const;
