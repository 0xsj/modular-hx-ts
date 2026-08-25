/**
 * Register a user. **`identity` app · command.** Conformance case 5.
 *
 * See `notes/domain/identity.md`.
 */

import { type Subject } from '../../../../shared/authz/index.js';
import { type Clock } from '../../../../shared/clock/index.js';
import { type IdGenerator } from '../../../../shared/id/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import {
  type Role,
  type User,
  IdentityEvent,
  Password,
  User as UserAggregate,
  email,
  userId,
} from '../../domain/index.js';
import { type Hasher, type Transactor } from '../ports.js';

export interface RegisterDeps {
  readonly transactor: Transactor;
  readonly hasher: Hasher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface RegisterInput {
  readonly email: string;
  /** Absent is legal: a user invited to set their own later has no password. */
  readonly password?: string | undefined;
  /** What a person is called. §3.5 names it in the specified payload. */
  readonly displayName?: string | undefined;
  /**
   * **Never from a request body on the public route.**
   *
   * `CONFORMANCE.md` §3.5: a register endpoint honouring a role from the body
   * is the privilege escalation §4.3 spends a section on. The parameter exists
   * for the composition root's `seed` and for an administrator creating an
   * account — both callers the transport layer does not let a stranger be.
   */
  readonly roles?: readonly Role[];
}

/**
 * Create an **active** user — case 5.
 *
 * The hash is computed **outside** the transaction on purpose. Argon2 is
 * deliberately slow, and holding a database transaction open across it puts
 * every registration inside the idle-in-transaction budget for the duration of
 * a memory-hard KDF.
 */
export async function register(
  deps: RegisterDeps,
  subject: Subject,
  input: RegisterInput,
  provenance: Provenance,
): Promise<User> {
  // `M4`. Anonymous on the public signup path, and present anyway: an
  // administrator creating an account for somebody is the same use case with a
  // different subject, and a signature that omitted it would need changing.
  void subject;
  const address = email(input.email);
  const hash =
    input.password === undefined
      ? undefined
      : await deps.hasher.hash(Password.of(input.password, address));

  const user = UserAggregate.register(
    userId(deps.ids.uuid()),
    address,
    hash,
    deps.clock.now(),
    input.roles ?? [],
    input.displayName,
  );

  return deps.transactor.within(async (work) => {
    // Uniqueness is the repository's — a duplicate address arrives as
    // `Conflict` from a unique violation rather than from a read this command
    // performed, because a read-then-insert has a window and the window is
    // exactly the concurrent-signup case.
    await work.users.create(user);

    await work.publish(
      {
        name: IdentityEvent.UserRegistered,
        payload: { subject: user.id, email: address },
      },
      provenance,
    );

    return user;
  });
}
