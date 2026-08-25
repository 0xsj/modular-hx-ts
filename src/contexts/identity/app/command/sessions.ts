/**
 * Ending sessions. **`identity` app · command.** Conformance cases 9, 10 and 11.
 *
 * **Cases 9 and 14 are different, and conflating them is the obvious error:**
 *
 * - a password **change** revokes every *other* session and leaves the current
 *   one live — the caller proved they know the old password, so they are not
 *   the threat;
 * - a password **reset** revokes **all** sessions, because the caller proved
 *   only that they control the mailbox, and the person holding a live session
 *   might be exactly who the reset is defending against.
 *
 * The reset half lands with challenges in slice 3 and calls the same helper
 * with no exception.
 *
 * See `notes/domain/identity.md`.
 */

import { type Subject } from '../../../../shared/authz/index.js';
import { type Clock } from '../../../../shared/clock/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type SessionId,
  type UserId,
  IdentityEvent,
} from '../../domain/index.js';
import { type Work } from '../ports.js';

export type RevokeReason =
  'logout' | 'password_changed' | 'disabled' | 'expired';

export interface RevokeDeps {
  readonly clock: Clock;
}

/**
 * End every session for a user, optionally sparing one.
 *
 * **One repository call rather than a read-then-loop.** Both callers are
 * security operations, and a loop that fails halfway leaves some sessions live
 * — a session surviving a password reset is the entire thing the reset was
 * for.
 *
 * The count is what `PasswordChanged` reports, and it is the number of sessions
 * actually ended rather than the number found: the difference is a session that
 * was already revoked, and reporting it would overstate what happened.
 */
export async function revokeAll(
  work: Work,
  deps: RevokeDeps,
  subject: Subject,
  userId: UserId,
  reason: RevokeReason,
  provenance: Provenance,
  except?: SessionId,
): Promise<number> {
  // `M4`. The sweep is driven by a password change, a reset or a disablement,
  // and *who* drove it is the difference between the three in `audit`.
  void subject;
  const revoked = await work.sessions.revokeAll(
    userId,
    deps.clock.now(),
    except,
  );

  if (revoked > 0) {
    // One event for the sweep rather than one per session. A password change
    // ending forty sessions is one thing that happened, and forty rows in
    // `audit` would bury it.
    await work.publish(
      {
        name: IdentityEvent.SessionRevoked,
        payload: {
          subject: userId,
          // The sweep has no single session id. `except` names what survived,
          // which is the fact a reader actually needs.
          sessionId: except ?? '',
          reason,
        },
      },
      provenance,
    );
  }

  return revoked;
}

/**
 * End one session — conformance case 10.
 *
 * Idempotent: logging out twice is a success, because the second call is
 * usually a retry and there is nothing to protect by refusing it.
 */
export async function revokeOne(
  work: Work,
  deps: RevokeDeps,
  subject: Subject,
  id: SessionId,
  reason: RevokeReason,
  provenance: Provenance,
): Promise<boolean> {
  void subject;
  const session = await work.sessions.byId(id);
  if (session === undefined) return false;

  const { changed } = session.revoke(deps.clock.now());
  if (!changed) return false;

  await work.sessions.save(session);
  await work.publish(
    {
      name: IdentityEvent.SessionRevoked,
      payload: {
        subject: session.userId,
        sessionId: session.id,
        reason,
      },
    },
    provenance,
  );

  return true;
}
