/**
 * Resolve a bearer token to a caller. **`identity` app · query.**
 *
 * The per-request lookup that conformance cases 8, 10, 11 and 12 all turn on,
 * and the reason §2.2 chose *fixed TTL plus revocation* over JWT: **roles are
 * read here, per request, rather than baked into a token.** Case 12 —
 * *roles assigned through the API take effect on the next request* — is a
 * property of that choice rather than a feature added on top of it.
 *
 * See `notes/domain/identity.md`.
 */

import { type Clock } from '../../../../shared/clock/index.js';
import { unauthenticated } from '../../../../shared/errors/index.js';
import {
  type ApiKey,
  type Session,
  type User,
  looksLikeApiKey,
} from '../../domain/index.js';
import {
  type ApiKeys,
  type OrgRoles,
  type Sessions,
  type Transactor,
  type Users,
} from '../ports.js';
import { fingerprintOf } from '../tokens.js';

export interface Caller {
  readonly user: User;
  /** Present when a session token got them in. */
  readonly session?: Session | undefined;
  /**
   * Present when an **API key** got them in — conformance cases 16 and 17.
   *
   * The two are mutually exclusive, and which one is set is what lets a route
   * refuse a key on key management, logout and password change.
   */
  readonly apiKey?: ApiKey | undefined;
  /**
   * The caller's roles **inside organizations** — `CONTEXTS.md` §4.
   *
   * Read through the `OrgRoles` port on every request, not cached on the
   * session: conformance case 12 requires a withdrawn grant to take effect on
   * the **next** request, and a role stored in a token is a role that outlives
   * its withdrawal until the token expires.
   *
   * Empty when the caller belongs to nothing **and** when `orgs` is not wired.
   * The two are deliberately indistinguishable here — that is what makes
   * `ORGS_ENABLED=false` a working configuration rather than a degraded one.
   */
  readonly orgs: readonly { readonly orgId: string; readonly role: string }[];
}

export interface CallerDeps {
  readonly orgRoles: OrgRoles;
  readonly users: Users;
  readonly sessions: Sessions;
  readonly apiKeys: ApiKeys;
  readonly clock: Clock;
  readonly transactor: Transactor;
}

/** One refusal for every reason, so a probe learns nothing from the wording. */
const refuse = (): Error =>
  unauthenticated('this session is not valid', {
    // **One slug for every way a session stops working.** The catalogue names
    // `token-expired` and `session-revoked` separately, and telling a caller
    // which would leak whether the token was ever real — the same oracle case
    // 13 refuses on challenges. A client's action is identical either way: log
    // in again.
    problem: 'session-revoked',
  });

/**
 * Look up the session behind a bearer token.
 *
 * **Fingerprint in, never the token** — the store holds no usable session, so
 * this is a lookup on `sha256:` of what the caller presented.
 *
 * Every failure is the same refusal: absent, unknown, expired, revoked, or
 * belonging to a user who has since been disabled. A caller holding a revoked
 * token and a caller holding a fabricated one must not be able to tell each
 * other's case apart.
 */
export async function resolveCaller(
  deps: CallerDeps,
  token: string,
): Promise<Caller> {
  // **One bearer scheme, two credential kinds, told apart by the prefix.** A
  // separate header would be a second thing to get wrong, and a key that looked
  // like a session token would be unscannable when leaked.
  if (looksLikeApiKey(token)) return resolveKey(deps, token);

  const session = await deps.sessions.byFingerprint(fingerprintOf(token));
  if (session === undefined) throw refuse();

  const now = deps.clock.now();
  // Revoked beats expired, and both are the same answer here — case 10's
  // *reusing that token afterwards is 401*.
  if (!session.isValidAt(now)) throw refuse();

  const user = await deps.users.byId(session.userId);
  if (user === undefined) throw refuse();

  // **Case 11: existing sessions stop working.** Checked per request rather
  // than by sweeping sessions when the user is disabled — a sweep is a race
  // with a login in flight, and this is the same read the request already
  // needed.
  if (!user.enabled) throw refuse();

  await recordUse(deps, session, now);

  return { user, session, orgs: await deps.orgRoles.of(user.id) };
}

async function resolveKey(deps: CallerDeps, token: string): Promise<Caller> {
  const apiKey = await deps.apiKeys.byFingerprint(fingerprintOf(token));
  if (apiKey === undefined) throw refuse();

  const now = deps.clock.now();
  if (!apiKey.isValidAt(now)) throw refuse();

  const user = await deps.users.byId(apiKey.userId);
  if (user === undefined) throw refuse();
  // **A key cannot outlive its owner's access.** Disabling a person disables
  // every key they hold, without anybody having to remember to sweep them.
  if (!user.enabled) throw refuse();

  await recordKeyUse(deps, apiKey, now);

  // **A key carries its owner's org roles**, the same as a session. Case 17's
  // scopes still subtract from whatever those confer — a scope is a narrowing,
  // never a grant, and that is `authz`'s to compute rather than this file's.
  return { user, apiKey, orgs: await deps.orgRoles.of(user.id) };
}

async function recordKeyUse(
  deps: CallerDeps,
  apiKey: ApiKey,
  now: Date,
): Promise<void> {
  const { changed } = apiKey.touch(now);
  if (!changed) return;
  try {
    await deps.transactor.within((work) => work.apiKeys.save(apiKey));
  } catch {
    // Same reasoning as a session touch: telemetry, not a security decision.
  }
}

/**
 * Record that the session was used, at most once a minute.
 *
 * **Best effort, and it fails open** — `RESILIENCE.md` §1 classifies a failing
 * session touch as *open, best effort*, because last-seen is telemetry rather
 * than a security decision. A caller whose request fails because a bookkeeping
 * write failed is an outage caused by a timestamp.
 */
async function recordUse(
  deps: CallerDeps,
  session: Session,
  now: Date,
): Promise<void> {
  const { changed } = session.touch(now);
  if (!changed) return;

  try {
    await deps.transactor.within((work) => work.sessions.save(session));
  } catch {
    // Deliberately swallowed. The session is valid; only the timestamp is not.
  }
}
