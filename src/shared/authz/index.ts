/**
 * Authorization. **L3 capability.**
 *
 * ```
 * Subject     { actor, roles, scopes?, tenant }   an explicit parameter, always
 * Action      "user:list"                         a named permission
 * Resource    { type, id?, ownerId? }
 * Authorizer  allow(subject, action, resource?) -> Decision
 * ```
 *
 * **The Subject is explicit where provenance is ambient**, and the difference is
 * this module's reason to exist. Nothing branches on provenance, so a missing
 * one degrades observability and grants nothing. A missing authorization check
 * **grants everything** — and were the subject ambient, the forgotten check
 * would be indistinguishable from the passed one at every call site.
 *
 * **Deny by default, structurally.** No matching grant denies; an unwired
 * authorizer is `denyAll`. A forgotten wire is 403s in the first test, never an
 * open admin endpoint. Invariant `I9`: security controls fail closed.
 *
 * **Policy is data owned by the composition root.** Contexts name permissions;
 * the root maps role → grants and validates it at boot. `authz` knows subjects,
 * actions and resources — not what a user is, which is what keeps it L3 while
 * `identity` is a context.
 *
 * Note: `notes/patterns/authz.md`.
 */

export {
  type Action,
  type Command,
  type Query,
  type Resource,
  type Subject,
  isAction,
  subject,
  subjectId,
} from './subject.js';

export {
  type Grant,
  type Policy,
  type PolicySpec,
  Scope,
  compilePolicy,
} from './policy.js';

export {
  type Authorizer,
  type AuthorizerOptions,
  type Decision,
  type Denial,
  type Reach,
  denyAll,
  makeAuthorizer,
  refusal,
} from './authorizer.js';
