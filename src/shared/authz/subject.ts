/**
 * Who is asking. **L3 capability.**
 *
 * **A `Subject` is a decision input, and that is why it is never ambient.**
 *
 * `provenance` travels in an `AsyncLocalStorage` and this deliberately does
 * not, and the difference is not taste. Nothing branches on provenance: a
 * missing correlation id degrades observability and **grants nothing**. A
 * missing authorization check **grants everything** — and if the subject were
 * ambient, the forgotten check would look identical to the passed one. Same
 * signature, same call site, no diff to review.
 *
 * So: **an explicit parameter on every use case.** Never read from a context,
 * never from a request, never from a global. If a use case can be called
 * without one, eventually it will be.
 *
 * `../../../ARCHITECTURE.md` Part II §3 rule 6, and rule `M4`.
 *
 * See `notes/patterns/authz.md`.
 */

import { invariant } from '../assert/index.js';
import { type Actor } from '../provenance/index.js';

/** A named permission — `user:list`, `session:read`, `audit:export`. */
export type Action = string;

const ACTION = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

/**
 * Plain `boolean`, not a type predicate.
 *
 * `Action` is a bare `string` — contexts name their own permissions and a brand
 * would make every call site construct one. A predicate `value is Action` would
 * therefore narrow the *negative* branch to `never`, so the failure message
 * could not name the value it rejected. The type claims no distinction, so
 * neither does this.
 */
export function isAction(value: string): boolean {
  return ACTION.test(value);
}

export interface Resource {
  /** `user`, `session`, `audit_record`. Matches the action's first segment. */
  readonly type: string;
  readonly id?: string;
  /**
   * Whose it is.
   *
   * The whole basis of `own` scope. Absent means unowned — a resource nobody
   * can claim, which an `own`-scoped grant therefore cannot reach.
   */
  readonly ownerId?: string;
}

export interface Subject {
  readonly actor: Actor;
  readonly roles: readonly string[];
  /**
   * Present when the caller is an API key rather than a person.
   *
   * **Scopes only ever subtract.** See `policy.ts`: the effective permission is
   * the intersection of these and the owner's grants, so a leaked key can never
   * exceed the human it belongs to.
   */
  readonly scopes?: readonly Action[];
  readonly tenant: string;
}

/**
 * The subject's own identifier, for `own`-scope comparison.
 *
 * An actor's id, not the whole `kind:id` form — a resource's `ownerId` is a
 * user id, and comparing against `user:01a0…` would never match.
 */
export function subjectId(subject: Subject): string {
  return subject.actor.id;
}

export function subject(candidate: Subject): Subject {
  invariant(candidate.tenant !== '', 'a subject belongs to a tenant');
  for (const scope of candidate.scopes ?? []) {
    invariant(isAction(scope), `a scope is an action: ${scope}`);
  }
  return candidate;
}

/**
 * The shape every mutating use case has. **The type-system half of `M4`.**
 *
 * A command declared as `Command<In, Out>` **cannot** omit the subject — the
 * assignment fails to compile. That is the same device `classification` uses
 * for `M9`: state the requirement in a type so the rule has almost nothing left
 * to catch, and leave the AST rule for the ways a type can be defeated.
 *
 * TypeScript *can* express this, which is worth saying because it was worth
 * checking. The subject is first, deliberately: a parameter that is always in
 * the same position is one a reviewer can scan for.
 */
export type Command<Input, Output> = (
  subject: Subject,
  input: Input,
) => Promise<Output>;

/**
 * A read.
 *
 * Also takes a subject, because `own` scope narrows a query and a query that
 * cannot be narrowed returns the whole tenant. `M4` covers commands only —
 * `../../../ARCHITECTURE.md` Part II §3 rule 6 scopes the *rule* to the
 * mutating side — but the type is here for the reads that need it.
 */
export type Query<Input, Output> = (
  subject: Subject,
  input: Input,
) => Promise<Output>;
