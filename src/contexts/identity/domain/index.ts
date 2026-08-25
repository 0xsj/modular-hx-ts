/**
 * The `identity` domain. **Imports only `errors`** — rule `S7`.
 *
 * Entities, value objects, invariants and events. No ports, no I/O, no
 * framework, no clock: time and ids arrive as arguments (§7.9).
 *
 * **One consequence of `S7` worth naming**, because it makes this domain read
 * differently from `src/shared`: `result` is not importable here, so value
 * objects **throw** rather than returning a `Result`. `ARCHITECTURE.md` §L0
 * calls `errors` *and* `result` the vocabulary of the kernel, while
 * `ENFORCEMENT.md` `S7` permits only `errors` — a gap that matters in a
 * language with a `Result` type and not in Go. Followed as written; see
 * `notes/domain/identity.md`.
 *
 * Boundary validation is zod's job in `transport/`, which is where a caller
 * gets every field problem at once (conformance case 2). These constructors are
 * the second line, and reaching one means the boundary let something through.
 */

export {
  type ApiKeyId,
  type ChallengeId,
  type SessionId,
  type UserId,
  apiKeyId,
  challengeId,
  sessionId,
  userId,
} from './ids.js';

export { type Email, email, emailOrUndefined } from './email.js';

export {
  type PasswordHash,
  Password,
  hasPassword,
  passwordHash,
} from './password.js';

export { type Role, normalizeRoles, role } from './role.js';

export { type Changed, type UserState, User, versionConflict } from './user.js';

export { type SessionState, AuthMethod, Session } from './session.js';

export {
  type ApiKeyState,
  API_KEY_PREFIX,
  ApiKey,
  looksLikeApiKey,
} from './apikey.js';

export {
  type ChallengeState,
  Challenge,
  Purpose,
  challengeMessage,
  challengeRefused,
  isPurpose,
} from './challenge.js';

export {
  type AuthenticationFailed,
  type PasswordChanged,
  type RoleGranted,
  type RoleRevoked,
  type SessionCreated,
  type SessionRevoked,
  type UserAuthenticated,
  type UserDisabled,
  type UserEmailChanged,
  type UserEnabled,
  type UserRegistered,
  IdentityEvent,
} from './events.js';
