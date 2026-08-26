/**
 * What the use cases need, in one bag. **`identity` app.**
 *
 * Assembled by the context root and injected by the composition root. `app/`
 * imports no adapter — rule `S8` — so every field here is either a port this
 * context declared or a shared module's own port type.
 *
 * See `notes/domain/identity.md`.
 */

import { type Authorizer } from '../../../shared/authz/index.js';
import { type Clock } from '../../../shared/clock/index.js';
import { type IdGenerator } from '../../../shared/id/index.js';
import { type Random } from '../../../shared/random/index.js';
import { type Telemetry } from '../../../shared/telemetry/index.js';
import { type Mac } from '../../../shared/crypto/index.js';
import {
  type ApiKeys,
  type ChallengeMailer,
  type Challenges,
  type Hasher,
  type Sessions,
  type OrgRoles,
  type Transactor,
  type Users,
} from './ports.js';

export interface IdentityDeps {
  readonly transactor: Transactor;
  /** Reads outside a unit of work, for `app/query`. */
  readonly users: Users;
  readonly sessions: Sessions;
  readonly challenges: Challenges;
  readonly apiKeys: ApiKeys;
  readonly hasher: Hasher;
  readonly mailer: ChallengeMailer;
  /** Tags challenges, binding each to its user and purpose. */
  readonly mac: Mac;
  /**
   * **Deny by default.** `denyAll` when the root wires nothing, so a forgotten
   * policy is 403s in the first test rather than an open admin endpoint.
   */
  readonly authorizer: Authorizer;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
  readonly telemetry: Telemetry;
  /** Fixed session TTL — §2.2. Revocation covers what a short one would. */
  readonly sessionTtlMs: number;
  /** How long an emailed link lives. Short: it is a credential in a mailbox. */
  readonly challengeTtlMs: number;
  /**
   * The caller's roles inside organizations — `CONTEXTS.md` §4.
   *
   * Declared here and satisfied by `orgs`, wired by the root, so neither
   * context imports the other. `noOrgs` when nothing is wired, and that is a
   * working configuration rather than a degraded one.
   */
  readonly orgRoles: OrgRoles;
}

export interface IdentityApp {
  readonly deps: IdentityDeps;
}

export {
  type ApiKeys,
  type OrgRoles,
  noOrgs,
  type ChallengeMailer,
  type Challenges,
  type Hasher,
  type Sessions,
  type Transactor,
  type Users,
  type Work,
} from './ports.js';
export { type Caller, resolveCaller } from './query/caller.js';
