/**
 * Issuing and consuming emailed secrets. **`identity` app · command.**
 * Conformance cases 13, 14 and 15.
 *
 * **One issue path and one consume path, for four purposes.** What differs is
 * only what happens *after* a consume succeeds, which is why §2.2 makes this
 * one aggregate rather than four.
 *
 * See `notes/domain/identity.md`.
 */

import { type Subject } from '../../../../shared/authz/index.js';
import { type Clock } from '../../../../shared/clock/index.js';
import { type Mac } from '../../../../shared/crypto/index.js';
import { unauthenticated } from '../../../../shared/errors/index.js';
import { type IdGenerator } from '../../../../shared/id/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { type Random } from '../../../../shared/random/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import {
  type Email,
  type User,
  AuthMethod,
  Challenge,
  IdentityEvent,
  Password,
  Purpose,
  challengeId,
  challengeMessage,
  challengeRefused,
  email as parseEmail,
} from '../../domain/index.js';
import {
  type ChallengeMailer,
  type Hasher,
  type Transactor,
  type Users,
  type Work,
} from '../ports.js';
import { type Challenges } from '../ports.js';
import { type Session } from '../../domain/index.js';
import { fingerprintOf, mintSecret } from '../tokens.js';
import {
  type Authenticated,
  type AuthenticateDeps,
  authenticate,
} from './authenticate.js';
import { type RevokeDeps, revokeAll } from './sessions.js';

export interface ChallengeDeps extends AuthenticateDeps, RevokeDeps {
  readonly transactor: Transactor;
  readonly users: Users;
  readonly hasher: Hasher;
  readonly mailer: ChallengeMailer;
  readonly mac: Mac;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  /** How long a link lives. Short: it is a credential sitting in a mailbox. */
  readonly challengeTtlMs: number;
  /**
   * The read side, for `consumeLink`'s purpose peek.
   *
   * Outside a transaction on purpose: nothing is decided from it. The claim
   * that matters happens inside `claim`, transactionally, which is what keeps
   * the peek from becoming a check-then-act.
   */
  readonly challenges: Challenges;
}

export interface RequestInput {
  readonly email: string;
  readonly purpose: Purpose;
  /** The new address, for `change_email`. Captured at issue time. */
  readonly payload?: string;
  /** §7.7. Present when a subscriber drove this, absent for a request. */
  readonly sourceEventId?: string;
}

/**
 * Issue a link, or **quietly do nothing**.
 *
 * **Conformance case 15: requesting a link for an unknown address returns the
 * same 202 as a known one.** So this returns `void` — there is no shape in
 * which a caller could learn which happened, because there is no value to carry
 * the difference. A `boolean` return would eventually be logged, counted per
 * request, or surfaced in a message.
 *
 * The transport layer answers 202 either way, and it can do nothing else.
 */
export async function requestChallenge(
  deps: ChallengeDeps,
  subject: Subject,
  input: RequestInput,
  provenance: Provenance,
): Promise<void> {
  // `M4`. Anonymous on three of the four link flows; `change_email` is
  // requested by the account's owner, and that is exactly the difference this
  // parameter carries.
  void subject;

  let address: Email;
  try {
    address = parseEmail(input.email);
  } catch {
    // Malformed is the same as unknown, for the same reason.
    return;
  }

  const user = await deps.users.byEmail(address);
  // A disabled account gets no links either — and, again, no different answer.
  if (!user?.enabled) return;

  const id = challengeId(deps.ids.uuid());
  const secret = mintSecret(deps.random);
  const now = deps.clock.now();
  const tag = unwrap(
    deps.mac.tag(challengeMessage(id, user.id, input.purpose)),
  );

  const challenge = Challenge.issue(
    id,
    user.id,
    input.purpose,
    secret.fingerprint,
    tag,
    now,
    new Date(now.getTime() + deps.challengeTtlMs),
    input.payload ?? '',
    input.sourceEventId,
  );

  await deps.transactor.within(async (work) => {
    await work.challenges.create(challenge);
    await work.publish(
      {
        name: IdentityEvent.ChallengeIssued,
        payload: {
          subject: user.id,
          challengeId: id,
          purpose: input.purpose,
          // **Not the secret.** The event is stored for the life of an audit
          // record; a secret on it is a credential in a table nobody thinks of
          // as holding credentials.
        },
      },
      provenance,
    );
  });

  // **Sent after the commit.** A message about a row that rolled back is a link
  // that does not work, and the recipient has no way to know why.
  await deps.mailer.send(address, input.purpose, secret.raw, challenge.payload);
}

/**
 * Find and verify the challenge behind a presented secret.
 *
 * **Every failure is `challengeRefused()`** — conformance case 13. Expired,
 * already consumed, wrong purpose, never existed, tag mismatch: one error.
 */
async function claim(
  work: Work,
  deps: ChallengeDeps,
  secret: string,
  purpose: Purpose,
  provenance: Provenance,
): Promise<Challenge> {
  const found = await work.challenges.byFingerprint(fingerprintOf(secret));
  if (found === undefined) throw challengeRefused();

  // **The MAC proves the row is ours and unaltered.** The fingerprint lookup
  // already proved possession of the secret; this proves the row was issued by
  // us for *this* user and *this* purpose, so a write that flipped a purpose
  // column cannot turn a magic link into a password reset.
  const expected = challengeMessage(found.id, found.userId, found.purpose);
  // A plain comparison on the purpose: it is a short, public, closed value and
  // the caller supplied it by choosing an endpoint. `constantTimeEqual` here
  // would be cargo cult — the secret was already compared by the fingerprint
  // lookup, and `Mac.verify` is constant-time over the tag.
  if (found.purpose !== purpose || !deps.mac.verify(expected, found.tag)) {
    throw challengeRefused();
  }

  // Throws the same refusal for expired and already-consumed.
  found.consume(deps.clock.now(), purpose);
  await work.challenges.save(found);

  await work.publish(
    {
      name: IdentityEvent.ChallengeConsumed,
      payload: { subject: found.userId, challengeId: found.id, purpose },
    },
    // The consumer is usually **anonymous** — they are holding a link, not a
    // session — so the actor is whatever position 6 established, which is
    // honest rather than invented. `audit` reads *somebody with this link did
    // this*, which is the truth available.
    provenance,
  );

  return found;
}

export interface ResetInput {
  readonly secret: string;
  readonly password: string;
}

/**
 * Reset a password from an emailed link.
 *
 * **Conformance case 14, and the contrast with case 9 is the whole point.** A
 * password *change* spares the caller's session, because they proved they know
 * the old password and are therefore not the threat. A *reset* proves only
 * control of the mailbox, and the person holding a live session might be
 * exactly who this is defending against — so **everything** goes:
 *
 * - every session, with no exception;
 * - **and the user's other outstanding reset links**, which is the half that
 *   gets forgotten. A second link mailed an hour earlier is still live, and the
 *   attacker who triggered it still has it.
 */
export async function resetPassword(
  deps: ChallengeDeps,
  subject: Subject,
  input: ResetInput,
  provenance: Provenance,
): Promise<void> {
  void subject;
  const hash = await deps.hasher.hash(Password.of(input.password));

  await deps.transactor.within(async (work) => {
    const challenge = await claim(
      work,
      deps,
      input.secret,
      Purpose.ResetPassword,
      provenance,
    );

    const user = await work.users.byId(challenge.userId);
    if (user === undefined) throw challengeRefused();

    const now = deps.clock.now();
    user.setPassword(hash, now);
    await work.users.save(user);

    // **No exception.** Compare `changePassword`, which spares one.
    const revokedSessions = await revokeAll(
      work,
      deps,
      subject,
      user.id,
      'password_changed',
      provenance,
    );

    // The half that gets forgotten.
    await work.challenges.expireOutstanding(
      user.id,
      Purpose.ResetPassword,
      now,
    );

    await work.publish(
      {
        name: IdentityEvent.PasswordChanged,
        payload: { subject: user.id, revokedSessions },
      },
      provenance,
    );
  });
}

/** Verify an email address from a link. */
export async function verifyEmail(
  deps: ChallengeDeps,
  subject: Subject,
  secret: string,
  provenance: Provenance,
): Promise<void> {
  void subject;
  await deps.transactor.within(async (work) => {
    const challenge = await claim(
      work,
      deps,
      secret,
      Purpose.VerifyEmail,
      provenance,
    );

    await work.publish(
      {
        name: IdentityEvent.EmailVerified,
        payload: { subject: challenge.userId },
      },
      provenance,
    );
  });
}

/** Apply an address change from a link. */
export async function changeEmail(
  deps: ChallengeDeps,
  subject: Subject,
  secret: string,
  provenance: Provenance,
): Promise<void> {
  void subject;
  await deps.transactor.within(async (work) => {
    const challenge = await claim(
      work,
      deps,
      secret,
      Purpose.ChangeEmail,
      provenance,
    );

    const user = await work.users.byId(challenge.userId);
    if (user === undefined) throw challengeRefused();

    // **The address from the challenge, not from the request.** It was
    // verified when the link was issued; taking it from the consuming request
    // would let anyone holding the link redirect it to an address they own.
    const next = parseEmail(challenge.payload);
    const { changed } = user.changeEmail(next, deps.clock.now());

    if (changed) {
      await work.users.save(user);
      await work.publish(
        {
          name: IdentityEvent.UserEmailChanged,
          payload: { subject: user.id, email: next },
        },
        provenance,
      );
    }
  });
}

/**
 * Log in from a magic link.
 *
 * **The second authentication method, and it is nine lines.** That is the
 * convergence point paying for itself: `authenticate` owns the TTL, the token,
 * the fingerprinting, the disabled check and both events, and this supplies a
 * `User` and a name.
 */
export async function magicLinkLogin(
  deps: ChallengeDeps,
  subject: Subject,
  secret: string,
  provenance: Provenance,
): Promise<Authenticated> {
  return deps.transactor.within(async (work) => {
    const challenge = await claim(
      work,
      deps,
      secret,
      Purpose.MagicLink,
      provenance,
    );

    const user: User | undefined = await work.users.byId(challenge.userId);
    if (user === undefined) throw unauthenticated('this link is not valid');

    return authenticate(
      work,
      deps,
      subject,
      user,
      AuthMethod.MagicLink,
      provenance,
    );
  });
}

/**
 * Consume a link, whatever it was for. **One route, one command** — §3.5.
 *
 * The purpose is **read from the challenge**, never from the request. Four
 * per-purpose paths restated something the server has to look up anyway, and
 * the token itself already identifies both the user and the purpose — so the
 * path was carrying nothing except a second place for the two to disagree.
 *
 * **The token stays out of the URL**, which is the half worth keeping in a
 * note. URLs reach access logs, referrer headers and browser history, and a
 * single-use secret that leaks into any of the three is spent before its owner
 * clicks it.
 *
 * The refusal is still case 13's single indistinguishable error: a token for a
 * purpose that needs a password, presented without one, fails exactly the way
 * an expired token does.
 */
export async function consumeLink(
  deps: ChallengeDeps,
  subject: Subject,
  input: { readonly token: string; readonly password?: string | undefined },
  provenance: Provenance,
): Promise<{ readonly session?: Session; readonly token?: string }> {
  const found = await deps.challenges.byFingerprint(fingerprintOf(input.token));
  // **A peek, not a claim.** Nothing is consumed here; `claim` inside each
  // command below does that transactionally. Answering from this read would be
  // a check-then-act with the whole command in the window.
  if (found === undefined) throw challengeRefused();

  switch (found.purpose) {
    case Purpose.ResetPassword: {
      if (input.password === undefined) throw challengeRefused();
      await resetPassword(
        deps,
        subject,
        { secret: input.token, password: input.password },
        provenance,
      );
      return {};
    }
    case Purpose.VerifyEmail:
      await verifyEmail(deps, subject, input.token, provenance);
      return {};
    case Purpose.ChangeEmail:
      await changeEmail(deps, subject, input.token, provenance);
      return {};
    case Purpose.MagicLink:
      return magicLinkLogin(deps, subject, input.token, provenance);
    default:
      throw challengeRefused();
  }
}
