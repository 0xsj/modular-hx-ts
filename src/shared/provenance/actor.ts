/**
 * Who is responsible for a unit of work. **L1 runtime.**
 *
 * `../../../PROVENANCE.md` §2: an actor is a value type, never a string. Its
 * shape ends up inside signed bytes — `attest` puts it in an in-toto predicate
 * and `integrity` MACs it — so §6 makes it **additive-only after the first
 * signature**. Old envelopes have to keep verifying.
 *
 * Two consequences follow directly:
 *
 * - **`Kind` is closed at four values**, because closed sets are safe to
 *   canonicalize. The vocabulary of system actors still grows freely, because
 *   growth happens in the **id path** — adding `system:reindex` changes no type
 *   and no canonical form.
 * - **`onBehalfOf` is defined now and populated in phase 2**, when
 *   `impersonation` lands. Adding it later would change the canonical form of
 *   every actor already signed.
 *
 * See `notes/patterns/provenance.md`.
 */

import { invariant } from '../assert/index.js';
import { isProvenanceId } from './ids.js';
import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

/**
 * The four kinds. Not an enum: `erasableSyntaxOnly` forbids those, and a const
 * object with a derived union canonicalizes identically in every language.
 */
export const ActorKind = {
  /** A person. The id is a user id. */
  User: 'user',
  /** Another service. The id names it: `service:webhooks`. */
  Service: 'service',
  /** This system acting on its own: `system:jobs/identity.purge`. */
  System: 'system',
  /** Nobody identified. The id is empty, and that is the only empty id. */
  Anonymous: 'anonymous',
} as const;

export type ActorKind = (typeof ActorKind)[keyof typeof ActorKind];

const KINDS: readonly ActorKind[] = Object.values(ActorKind);

/** The serialized form. Snake_case, per §2 — these exact keys are hashed. */
export interface ActorWire {
  readonly kind: ActorKind;
  readonly id: string;
  readonly on_behalf_of?: ActorWire;
}

class ActorValue {
  readonly #kind: ActorKind;
  readonly #id: string;
  readonly #onBehalfOf: ActorValue | undefined;

  constructor(kind: ActorKind, id: string, onBehalfOf?: ActorValue) {
    this.#kind = kind;
    this.#id = id;
    this.#onBehalfOf = onBehalfOf;
  }

  get kind(): ActorKind {
    return this.#kind;
  }

  get id(): string {
    return this.#id;
  }

  /** The principal this actor acts for, if any. Populated in phase 2. */
  get onBehalfOf(): Actor | undefined {
    return this.#onBehalfOf;
  }

  /**
   * `kind:id` — `user:01a024c7…`, `system:jobs/identity.purge`, `anonymous:`.
   *
   * For logs and for round-tripping a single actor. Delegation is not in this
   * form; use the wire object when both principals matter.
   */
  toString(): string {
    return `${this.#kind}:${this.#id}`;
  }

  /**
   * The canonical object form.
   *
   * Implemented as `toJSON` on purpose: fields are private, so this is the only
   * way an actor becomes JSON, and an accidental `JSON.stringify` produces the
   * right bytes rather than `{}`. `on_behalf_of` is **omitted when absent**,
   * never `null` — §6, and the reason cross-language parity holds.
   */
  toJSON(): ActorWire {
    return {
      kind: this.#kind,
      id: this.#id,
      ...(this.#onBehalfOf === undefined
        ? {}
        : { on_behalf_of: this.#onBehalfOf.toJSON() }),
    };
  }

  /** A copy acting for another principal. Immutable: this returns a new actor. */
  actingFor(principal: Actor): Actor {
    invariant(
      principal instanceof ActorValue,
      'an actor acts for another actor',
    );
    return new ActorValue(this.#kind, this.#id, principal);
  }

  equals(other: Actor): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }
}

export type Actor = ActorValue;

function make(kind: ActorKind, id: string): Actor {
  return new ActorValue(kind, id);
}

/**
 * Validate an id against its kind.
 *
 * `anonymous` is the only kind with an empty id, and it is required to be empty
 * — `anonymous:someone` is a contradiction, and allowing it would put an
 * unauthenticated identifier somewhere an authenticated one is expected.
 */
function validate(kind: ActorKind, id: string): Result<string> {
  if (kind === ActorKind.Anonymous) {
    return id === '' ? ok(id) : err(invalid('an anonymous actor has no id'));
  }

  // The id path uses the same charset as every other provenance id (§5):
  // wide enough for a UUID, a hierarchical name like `jobs/identity.purge`, or
  // a peer's opaque id. Parsing splits on the first colon, so ids may contain
  // colons.
  return isProvenanceId(id)
    ? ok(id)
    : err(invalid(`not a valid ${kind} actor id`));
}

/**
 * Read an actor back from `kind:id`.
 *
 * Splits on the first colon, so the id may contain colons. Untrusted input —
 * a stored row, a header, a decoded envelope — so it returns a `Result`.
 */
function parse(value: string): Result<Actor> {
  const separator = value.indexOf(':');
  if (separator === -1) return err(invalid('not a valid actor'));

  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);

  if (!(KINDS as readonly string[]).includes(kind)) {
    return err(invalid('not a valid actor kind'));
  }

  const validated = validate(kind as ActorKind, id);
  return validated.ok ? ok(make(kind as ActorKind, id)) : err(validated.error);
}

/**
 * Read an actor back from its wire object.
 *
 * Recursive, because `on_behalf_of` is part of the canonical form (§6).
 * Reconstructing through the `kind:id` string form instead would silently drop
 * the second principal — and a record that verified when written would stop
 * verifying when read.
 */
function fromWire(value: unknown): Result<Actor> {
  if (typeof value !== 'object' || value === null) {
    return err(invalid('not a valid actor'));
  }

  const {
    kind,
    id,
    on_behalf_of: onBehalfOf,
  } = value as {
    kind?: unknown;
    id?: unknown;
    on_behalf_of?: unknown;
  };

  if (typeof kind !== 'string' || typeof id !== 'string') {
    return err(invalid('not a valid actor'));
  }

  const base = parse(`${kind}:${id}`);
  if (!base.ok || onBehalfOf === undefined) return base;

  const principal = fromWire(onBehalfOf);
  return principal.ok
    ? ok(base.value.actingFor(principal.value))
    : err(principal.error);
}

/**
 * Constructors.
 *
 * A type and a value under one name: TypeScript keeps them in separate
 * namespaces, so `Actor.system('jobs/purge')` and `actor: Actor` both read as
 * the same thing.
 */
export const Actor = {
  /** A person. */
  user(id: string): Result<Actor> {
    const validated = validate(ActorKind.User, id);
    return validated.ok ? ok(make(ActorKind.User, id)) : err(validated.error);
  },

  /** Another service, named: `webhooks`, `exports`. */
  service(name: string): Result<Actor> {
    const validated = validate(ActorKind.Service, name);
    return validated.ok
      ? ok(make(ActorKind.Service, name))
      : err(validated.error);
  },

  /**
   * This system, acting on its own behalf.
   *
   * The path is where the vocabulary grows — `jobs/identity.purge`, `migrate`,
   * `boot`, `cli/seed` — which is what keeps `Kind` closed and the canonical
   * form stable.
   */
  system(path: string): Result<Actor> {
    const validated = validate(ActorKind.System, path);
    return validated.ok
      ? ok(make(ActorKind.System, path))
      : err(validated.error);
  },

  /** Nobody identified. Always valid; there is nothing to get wrong. */
  anonymous(): Actor {
    return make(ActorKind.Anonymous, '');
  },

  parse,
  fromWire,

  is(value: unknown): value is Actor {
    return value instanceof ActorValue;
  },
} as const;
