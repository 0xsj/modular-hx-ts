/**
 * Granting and revoking roles. **`identity` app · command.** Conformance case 12.
 *
 * **Identity records *which* roles a user holds; it does not know what any of
 * them permit.** The composition root's policy decides that, and this context
 * never imports it — which is why granting `admin` here needs no knowledge of
 * what `admin` can do.
 *
 * **Case 12 — roles take effect on the *next* request — needs no code.** It is
 * a property of §2.2's *fixed TTL plus revocation, not JWT*: the session
 * carries no roles, so `resolveCaller` reads them fresh on every request and
 * there is no token to reissue and no cache to invalidate. A JWT design would
 * have to solve this, and the usual solution is a short TTL that makes the case
 * *nearly* true.
 *
 * **Authorization happens here, with an explicit `Subject`** — `ARCHITECTURE.md`
 * §3 rule 6. Never in transport, never from ambient state.
 *
 * See `notes/domain/identity.md`.
 */

import { type Clock } from '../../../../shared/clock/index.js';
import {
  type Authorizer,
  type Subject,
} from '../../../../shared/authz/index.js';
import { forbidden, notFound } from '../../../../shared/errors/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Role,
  type User,
  type UserId,
  IdentityEvent,
} from '../../domain/index.js';
import { type Transactor, type Users } from '../ports.js';

export interface RoleDeps {
  readonly transactor: Transactor;
  readonly users: Users;
  readonly clock: Clock;
  readonly authorizer: Authorizer;
}

/**
 * `type:verb`, and the type matches the resource's — `authz` §subject.
 *
 * Named here rather than in the root's policy, because the *permission* is this
 * context's vocabulary and only what it **grants** is the root's decision.
 */
export const GRANT_ROLE = 'user:grant_role';
export const REVOKE_ROLE = 'user:revoke_role';

export interface RoleChange {
  readonly changed: boolean;
  readonly version: number;
  readonly roles: readonly string[];
}

async function change(
  deps: RoleDeps,
  subject: Subject,
  action: string,
  target: UserId,
  provenance: Provenance,
  apply: (user: User, at: Date) => { readonly changed: boolean },
  eventName: string,
  named: Role,
): Promise<RoleChange> {
  // Explicit `Subject`, passed in from the boundary — never read from ambient
  // state. `denyAll` is the default authorizer, so an unwired policy refuses.
  const decision = deps.authorizer.allow(subject, action, {
    type: 'user',
    id: target,
    // A user owns themselves, which is what lets an `own`-scoped grant cover
    // "manage my own roles" without a second action.
    ownerId: target,
  });
  if (!decision.allowed) {
    // Case 18's *deny by default*: `denyAll` is the authorizer used when none
    // was wired, so an unwired policy refuses rather than admits.
    throw forbidden(`not permitted: ${decision.reason}`);
  }

  const user = await deps.users.byId(target);
  if (user === undefined) throw notFound('no such user');

  return deps.transactor.within(async (work) => {
    const { changed } = apply(user, deps.clock.now());

    if (changed) {
      await work.users.save(user);
      await work.publish(
        {
          name: eventName,
          // **The subject is the user acted upon, and the actor rides the
          // envelope** — §2.5. An administrator granting somebody else a role
          // is exactly the case where assuming them equal is wrong.
          payload: { subject: user.id, role: named },
        },
        provenance,
      );
    }

    return {
      changed,
      version: user.version,
      roles: [...user.roles],
    };
  });
}

export function grantRole(
  deps: RoleDeps,
  subject: Subject,
  target: UserId,
  named: Role,
  provenance: Provenance,
): Promise<RoleChange> {
  return change(
    deps,
    subject,
    GRANT_ROLE,
    target,
    provenance,
    (user, at) => user.grantRole(named, at),
    IdentityEvent.RoleGranted,
    named,
  );
}

export function revokeRole(
  deps: RoleDeps,
  subject: Subject,
  target: UserId,
  named: Role,
  provenance: Provenance,
): Promise<RoleChange> {
  return change(
    deps,
    subject,
    REVOKE_ROLE,
    target,
    provenance,
    (user, at) => user.revokeRole(named, at),
    IdentityEvent.RoleRevoked,
    named,
  );
}
