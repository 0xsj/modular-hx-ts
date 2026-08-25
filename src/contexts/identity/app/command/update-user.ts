/**
 * Update a user. **`identity` app · command.** `CONFORMANCE.md` §3.5.
 *
 * **`PATCH /v1/users/{id}` is where enable and disable live**, rather than two
 * RPC-shaped sub-resource verbs. The route already carries `If-Match`, and the
 * domain's `Disable`/`Enable` are already idempotent — a `/disable` path would
 * add a second way to spell one thing and a second place to forget the
 * precondition.
 *
 * **Concurrency is checked twice, in two different places, on purpose.**
 * `conditional` at position 9 refuses a request whose `If-Match` names a
 * representation that has moved — conformance case 29, and it happens before
 * this command runs. The repository's write on `(id, baseVersion)` catches the
 * row moving between *this* read and *this* write, which is a window position 9
 * cannot see. A third comparison here against a version parsed out of the
 * header would be neither: an ETag identifies a representation and does not
 * encode a version, so parsing one out of it is the §3 mistake in a new place.
 *
 * See `notes/domain/identity.md`.
 */

import {
  type Authorizer,
  type Subject,
} from '../../../../shared/authz/index.js';
import { type Clock } from '../../../../shared/clock/index.js';
import { forbidden, notFound } from '../../../../shared/errors/index.js';
import { type Event } from '../../../../shared/events/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type User,
  type UserId,
  IdentityEvent,
  email,
} from '../../domain/index.js';
import { type Transactor, type Users } from '../ports.js';

export interface UpdateDeps {
  readonly transactor: Transactor;
  readonly users: Users;
  readonly clock: Clock;
  readonly authorizer: Authorizer;
}

/** `type:verb`, matching the resource — `authz` §subject. */
export const UPDATE_USER = 'user:update';

export interface UpdateInput {
  readonly target: UserId;
  readonly email?: string | undefined;
  /** `null` clears it; absent leaves it alone. The two are different. */
  readonly displayName?: string | null | undefined;
  readonly status?: 'active' | 'disabled' | undefined;
}

export async function updateUser(
  deps: UpdateDeps,
  subject: Subject,
  input: UpdateInput,
  provenance: Provenance,
): Promise<User> {
  const decision = deps.authorizer.allow(subject, UPDATE_USER, {
    type: 'user',
    id: input.target,
    // A user owns themselves, which is what lets an `own`-scoped permission
    // mean "edit my own profile" with no second action.
    ownerId: input.target,
  });
  if (!decision.allowed) {
    throw forbidden(`not permitted: ${decision.reason}`);
  }

  const user = await deps.users.byId(input.target);
  // 404 rather than 403 for a stranger's id — case 23, and the same rule the
  // detail route follows: a 403 confirms existence and turns any id into an
  // oracle.
  if (user === undefined) throw notFound('no such user');

  const readAt = user.version;

  return deps.transactor.within(async (work) => {
    const at = deps.clock.now();
    const events: Event[] = [];

    if (input.email !== undefined) {
      const address = email(input.email);
      if (user.changeEmail(address, at).changed) {
        events.push({
          name: IdentityEvent.UserEmailChanged,
          payload: { subject: user.id, email: address },
        });
      }
    }

    if (input.displayName !== undefined) {
      // `null` clears, a string sets. `rename` is idempotent and reports
      // whether it changed anything, which is what keeps the event count right.
      user.rename(input.displayName ?? undefined, at);
    }

    if (input.status !== undefined) {
      const changed =
        input.status === 'disabled'
          ? user.disable(at).changed
          : user.enable(at).changed;
      if (changed) {
        events.push({
          name:
            input.status === 'disabled'
              ? IdentityEvent.UserDisabled
              : IdentityEvent.UserEnabled,
          payload: { subject: user.id },
        });
      }
    }

    // **A no-op PATCH writes nothing and publishes nothing**, and still answers
    // 200 with the current representation. That is not laziness: bumping the
    // version on a request that changed nothing invalidates every cached ETag
    // for no reason, which is the §3 bug arriving from a new direction.
    if (user.version !== readAt) {
      await work.users.save(user);
      for (const event of events) await work.publish(event, provenance);
    }

    return user;
  });
}
