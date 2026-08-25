/**
 * What `identity` puts on the wire. **`identity` transport.**
 *
 * **Views, not aggregates.** A response shape is a published contract and an
 * aggregate is an internal model; serializing the aggregate directly ties every
 * future refactor to the API, and — more immediately — it is how a
 * `passwordHash` ends up in a JSON body. Nothing here can leak one, because
 * nothing here reads one.
 *
 * **Snake case, and it is normative.** `../../../../../CONFORMANCE.md` §3.5:
 * the login field is `access_token`, and the cases interpolate it sixty times.
 * These were camelCase, which is idiomatic TypeScript and is the wrong axis —
 * the wire is a contract shared with a Go and a Python sibling, and a client
 * must not be able to tell which one it is talking to. Internal names stay
 * camelCase; only what crosses the boundary changes.
 *
 * See `notes/domain/identity.md`.
 */

import { type User } from '../../domain/index.js';

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly display_name?: string;
  readonly roles: readonly string[];
  /**
   * `status`, not `enabled`.
   *
   * §3.5 settles enable and disable as `PATCH /v1/users/{id}` rather than
   * sub-resource verbs, and a boolean called `enabled` is a field that cannot
   * grow a third state. The corpus already speaks of `active`.
   */
  readonly status: 'active' | 'disabled';
  /** The optimistic-concurrency token, and what the ETag is derived from. */
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export function userView(user: User): UserView {
  return {
    id: user.id,
    email: user.email,
    ...(user.displayName === undefined
      ? {}
      : { display_name: user.displayName }),
    roles: [...user.roles],
    status: user.enabled ? 'active' : 'disabled',
    version: user.version,
    created_at: user.createdAt.toISOString(),
    updated_at: user.updatedAt.toISOString(),
  };
}
