/**
 * Password login. **`identity` app · command.** Conformance cases 6, 7 and 11.
 *
 * **This is a method, not the session logic.** Everything after "the password
 * is right" belongs to `authenticate` — the convergence point — and the whole
 * of this file is the password-shaped part.
 *
 * **Case 7 is the hard one, and it is about timing as much as about wording.**
 * Wrong password and unknown address must return the identical status, body and
 * *timing class*. A login that skips verification when the address is unknown
 * returns measurably faster, and that difference is an enumeration oracle: an
 * attacker learns which addresses are registered without ever authenticating.
 *
 * See `notes/domain/identity.md`.
 */

import { type Subject } from '../../../../shared/authz/index.js';
import { unauthenticated } from '../../../../shared/errors/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Counter,
  type Telemetry,
} from '../../../../shared/telemetry/index.js';
import {
  type PasswordHash,
  type UserId,
  AuthMethod,
  IdentityEvent,
  Password,
  emailOrUndefined,
} from '../../domain/index.js';
import { type Hasher, type Transactor, type Users } from '../ports.js';
import {
  type Authenticated,
  type AuthenticateDeps,
  authenticate,
} from './authenticate.js';

export interface LoginDeps extends AuthenticateDeps {
  readonly transactor: Transactor;
  /** Read outside the unit of work: the lookup precedes any write. */
  readonly users: Users;
  readonly hasher: Hasher;
  readonly telemetry: Telemetry;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
}

/**
 * **One refusal, for every reason.** §2.2: same error for wrong email and wrong
 * password.
 *
 * Built once as a value so no branch can accidentally differ in wording, and
 * so a future contributor adding a case has nothing to spell differently.
 */
const refuse = (): Error =>
  unauthenticated('invalid email or password', {
    // **`invalid-credentials`, and it is the same slug for both failures.**
    // Case 7: a wrong password and an unknown address answer identically, and
    // `type` is the field a client branches on — two slugs here would be the
    // enumeration oracle the identical body was built to prevent.
    problem: 'invalid-credentials',
  });

/**
 * Counters, because the facts still matter — they just must not reach the bus.
 *
 * §2.2: `AuthenticationFailed` **fires only for existing users**, because an
 * unknown address is unverified input and publishing it writes an attacker's
 * guesses into `audit`. A count carries the operational signal — a spike in
 * `unknown` is credential stuffing — without recording the strings.
 */
function counters(telemetry: Telemetry): {
  unknown: Counter;
  badPassword: Counter;
  disabled: Counter;
} {
  const meter = telemetry.meter;
  return {
    unknown: meter.counter('identity.login.unknown_address'),
    badPassword: meter.counter('identity.login.bad_password'),
    disabled: meter.counter('identity.login.disabled'),
  };
}

export async function login(
  deps: LoginDeps,
  subject: Subject,
  input: LoginInput,
  provenance: Provenance,
): Promise<Authenticated> {
  // `M4`. Necessarily anonymous — you cannot be authenticated while
  // authenticating — and explicit rather than assumed.
  const count = counters(deps.telemetry);
  const address = emailOrUndefined(input.email);

  // A malformed address is *not* a validation error here. Answering 400 for
  // "not an address" and 401 for "wrong password" is an enumeration oracle
  // wearing a different status code, so it takes the no-such-user path.
  const user =
    address === undefined ? undefined : await deps.users.byEmail(address);

  // **The password is parsed leniently on this path**, for the same reason: a
  // too-short password must not answer differently from a wrong one. Anything
  // that fails the policy simply cannot match a stored hash.
  const presented = lenientPassword(input.password);

  // **The work happens either way** — case 7. `dummy` is a real hash, verified
  // through the same call, so the two paths are one code path with a different
  // argument. A `verifyDummy()` method would be a second path, and a second
  // path is where the timing difference comes back.
  const hash = user?.passwordHash ?? deps.hasher.dummy;
  const matched =
    presented === undefined
      ? await spend(deps.hasher, hash)
      : await deps.hasher.verify(hash, presented);

  if (user === undefined) {
    count.unknown.add(1);
    throw refuse();
  }

  // A user with no password at all — SSO-only, or invited and not yet set —
  // cannot log in this way. Still the same refusal, still after the work.
  if (!matched || !user.hasPassword) {
    count.badPassword.add(1);
    await failed(deps, user.id, 'bad_password', provenance);
    throw refuse();
  }

  if (!user.enabled) {
    // Case 11. Same refusal as a wrong password: *this account is disabled* is
    // a fact about an address that exists, and telling an unauthenticated
    // caller is the oracle again.
    count.disabled.add(1);
    await failed(deps, user.id, 'disabled', provenance);
    throw refuse();
  }

  return deps.transactor.within(async (work) => {
    // **Verify-then-rehash** — collection decision 0011's accepted upgrade path
    // for a stored hash below policy. This is the only moment the plaintext is
    // in hand *and* the caller is proven, so it is the only moment an upgrade
    // is possible at all. Silent acceptance is what the conformance fixture
    // refuses; doing nothing here would be exactly that.
    if (deps.hasher.needsRehash(hash)) {
      const upgraded = await deps.hasher.hash(
        presented ?? Password.of(input.password),
      );
      user.setPassword(upgraded, deps.clock.now());
      await work.users.save(user);
    }

    return authenticate(
      work,
      deps,
      subject,
      user,
      AuthMethod.Password,
      provenance,
    );
  });
}

/** Parse without the policy, since a policy failure must not be observable. */
function lenientPassword(raw: string): Password | undefined {
  try {
    return Password.of(raw);
  } catch {
    return undefined;
  }
}

/**
 * Spend the verification cost on a value that cannot match.
 *
 * Reached when the *presented* password fails the length policy — which must
 * not be observable either, so it costs the same as a wrong one.
 */
async function spend(hasher: Hasher, hash: PasswordHash): Promise<boolean> {
  await hasher.verify(hash, Password.of('x'.repeat(16)));
  return false;
}

async function failed(
  deps: LoginDeps,
  subject: UserId,
  reason: 'bad_password' | 'disabled',
  provenance: Provenance,
): Promise<void> {
  await deps.transactor.within((work) =>
    work.publish(
      {
        name: IdentityEvent.AuthenticationFailed,
        payload: { subject, reason },
      },
      provenance,
    ),
  );
}
