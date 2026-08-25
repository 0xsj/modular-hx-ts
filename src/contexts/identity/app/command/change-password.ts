/**
 * Change a password. **`identity` app · command.** Conformance case 9.
 *
 * **Revokes every *other* session and leaves the current one live.** The caller
 * proved they know the old password, so they are not the threat — logging them
 * out of the device they are typing on is a usability tax with no security
 * benefit. Everything else goes, because the reason people change a password is
 * that they think somebody else has it.
 *
 * Contrast the reset in slice 3, which spares nothing.
 *
 * See `notes/domain/identity.md`.
 */

import { type Subject } from '../../../../shared/authz/index.js';
import { unauthenticated } from '../../../../shared/errors/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type SessionId,
  type UserId,
  IdentityEvent,
  Password,
} from '../../domain/index.js';
import { type Hasher, type Transactor, type Users } from '../ports.js';
import { type RevokeDeps, revokeAll } from './sessions.js';

export interface ChangePasswordDeps extends RevokeDeps {
  readonly transactor: Transactor;
  readonly users: Users;
  readonly hasher: Hasher;
}

export interface ChangePasswordInput {
  readonly userId: UserId;
  readonly current: string;
  readonly next: string;
  /** The session doing the changing. Spared — case 9. */
  readonly currentSession: SessionId;
}

export interface PasswordChangeResult {
  readonly revokedSessions: number;
  readonly version: number;
}

export async function changePassword(
  deps: ChangePasswordDeps,
  subject: Subject,
  input: ChangePasswordInput,
  provenance: Provenance,
): Promise<PasswordChangeResult> {
  const user = await deps.users.byId(input.userId);
  // The caller is authenticated, so a missing user is a stale session rather
  // than a bad request — and `unauthenticated` is what the edge should answer.
  if (user === undefined) throw unauthenticated('this session is not valid');

  // **Re-verification is the point of the operation.** Without it, a stolen
  // session becomes a stolen account: the thief sets a password they know and
  // the owner is locked out of their own recovery.
  const matched =
    user.hasPassword &&
    (await deps.hasher.verify(
      user.passwordHash ?? deps.hasher.dummy,
      Password.of(input.current),
    ));

  if (!matched) {
    // Not the login refusal — this caller is already authenticated, so there is
    // no address to enumerate and nothing to hide behind a generic message.
    throw unauthenticated('the current password is not correct');
  }

  const hash = await deps.hasher.hash(Password.of(input.next, user.email));

  return deps.transactor.within(async (work) => {
    user.setPassword(hash, deps.clock.now());
    await work.users.save(user);

    const revokedSessions = await revokeAll(
      work,
      deps,
      subject,
      user.id,
      'password_changed',
      provenance,
      // **The one exception, and the whole difference from a reset.**
      input.currentSession,
    );

    await work.publish(
      {
        name: IdentityEvent.PasswordChanged,
        payload: { subject: user.id, revokedSessions },
      },
      provenance,
    );

    return { revokedSessions, version: user.version };
  });
}
