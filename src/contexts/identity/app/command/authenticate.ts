/**
 * **The convergence point.** `identity` app · command.
 *
 * §2.2: *every authentication method ends in `NewSession` + `UserAuthenticated`.*
 * This file is that ending, and it is built now — while there is exactly one
 * method — because it is what makes SSO, MFA and passkeys **additive rather
 * than a rewrite**.
 *
 * The reason it is hard to add later is not technical. By the time a second
 * method exists, the first one's session creation is inlined in a login
 * handler; the second copies it; the third copies whichever it found. Then
 * there are three places that decide a session's TTL, three that publish
 * `SessionCreated`, and the one that forgot to check `enabled` is the one
 * somebody logs in through.
 *
 * **What a method supplies:** a `User` it has already authenticated somehow,
 * and the name of how. **What it does not decide:** the TTL, the token, the
 * fingerprinting, the events, or whether the account may log in at all.
 *
 * See `notes/domain/identity.md`.
 */

import { type Subject } from '../../../../shared/authz/index.js';
import { type Clock } from '../../../../shared/clock/index.js';
import { type IdGenerator } from '../../../../shared/id/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { type Random } from '../../../../shared/random/index.js';
import {
  type AuthMethod,
  type Session,
  type User,
  IdentityEvent,
  Session as SessionAggregate,
  sessionId,
} from '../../domain/index.js';
import { type Work } from '../ports.js';
import { mintSecret } from '../tokens.js';

export interface Authenticated {
  readonly session: Session;
  /**
   * The bearer token, in the clear, for this response only.
   *
   * The only moment it exists outside the caller's possession. Nothing stores
   * it and nothing logs it — the aggregate holds a fingerprint.
   */
  readonly token: string;
}

export interface AuthenticateDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  /** Fixed TTL — §2.2. Revocation handles everything a short TTL would. */
  readonly sessionTtlMs: number;
}

/**
 * Issue a session for a user some method has already authenticated.
 *
 * **Refuses a disabled account here**, not in the caller — conformance case 11,
 * and the first dividend of the convergence point: every method that ever
 * exists inherits the check without knowing it made one.
 */
export async function authenticate(
  work: Work,
  deps: AuthenticateDeps,
  subject: Subject,
  user: User,
  method: AuthMethod,
  provenance: Provenance,
): Promise<Authenticated> {
  // **Rule `M4`: the `Subject` is an explicit parameter on every use case.**
  //
  // It is `anonymous:` on every path that reaches here today — you cannot be
  // authenticated while authenticating — and taking it anyway is the point. A
  // command whose signature omits it is one that will reach for ambient state
  // the first time it needs to make a decision, and `PROVENANCE.md`'s carriage
  // rule is that a boundary reads ambient and passes explicit.
  //
  // It becomes load-bearing the moment a method authenticates *on behalf of*
  // somebody — impersonation is a phase-2 aggregate, and this is the parameter
  // it will need.
  void subject;
  user.assertCanAuthenticate();

  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + deps.sessionTtlMs);
  const secret = mintSecret(deps.random);

  const session = SessionAggregate.issue(
    sessionId(deps.ids.uuid()),
    user.id,
    secret.fingerprint,
    method,
    now,
    expiresAt,
  );

  await work.sessions.create(session);

  // Two events, and they are not redundant. `session.created` is the
  // lifecycle fact `audit` needs to pair with `session.revoked`;
  // `user.authenticated` is the security fact — somebody got in, by this
  // method, at this time. A single event would force every consumer of one to
  // filter the other.
  await work.publish(
    {
      name: IdentityEvent.SessionCreated,
      payload: {
        subject: user.id,
        sessionId: session.id,
        method,
        expiresAt: expiresAt.toISOString(),
      },
    },
    provenance,
  );
  await work.publish(
    {
      name: IdentityEvent.UserAuthenticated,
      payload: { subject: user.id, sessionId: session.id, method },
    },
    provenance,
  );

  return { session, token: secret.raw };
}
