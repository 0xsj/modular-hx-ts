/**
 * Position 6's authenticator. **`identity` transport.**
 *
 * **This exists because of a defect the end-to-end tests found**, and it is
 * worth stating plainly: the router resolved the bearer token itself, which
 * worked — every authenticated route returned the right thing — while the
 * chain's provenance still said `anonymous:`. So every event `identity`
 * published named no actor, and `audit` would have recorded *somebody disabled
 * this account* with no answer to *who*.
 *
 * Nothing below the edge could have caught it. The command had the right user,
 * the repository wrote the right row, and only the envelope was wrong.
 *
 * **The fix is to authenticate where the chain says to.** Position 6 sets the
 * actor on the provenance; everything below — the access log, every event, the
 * `Subject` an authorization decision is made against — reads it from there.
 *
 * **Optional by design.** It sets an actor when a valid token is presented and
 * leaves the exchange anonymous otherwise. Whether a *route* requires one is a
 * routing decision, and position 6 runs before routing — so the refusal belongs
 * to the registry, which knows.
 *
 * See `notes/domain/identity.md`.
 */

import { type Exchange } from '../../../../shared/edge/index.js';
import { Actor } from '../../../../shared/provenance/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import { type Caller } from '../../app/query/caller.js';

/**
 * One resolution per request, shared by position 6 and the router.
 *
 * Keyed on the `Exchange`, which **is** the request — so the entry dies with
 * it and there is nothing to evict. Without this the session is read twice per
 * authenticated request: once to set the actor and once to hand the handler its
 * caller.
 */
const resolved = new WeakMap<Exchange, Caller>();

export interface AuthnOptions {
  readonly resolve: (token: string) => Promise<Caller>;
}

/** `Authorization: Bearer <token>`, or nothing. */
export function bearerToken(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const [scheme, token] = (headers['authorization'] ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return undefined;
  return token === undefined || token === '' ? undefined : token;
}

export function identityAuthenticator(options: AuthnOptions) {
  return async (exchange: Exchange): Promise<void> => {
    const token = bearerToken(exchange.request.headers);
    if (token === undefined) return;

    let caller: Caller;
    try {
      caller = await options.resolve(token);
    } catch {
      // **Silent, and deliberately.** A bad token on a public route is not an
      // error — the caller is simply anonymous, and a route that needs one
      // refuses in the registry with the single 401 every failure mode shares.
      // Throwing here would 401 every unauthenticated request to a public
      // endpoint that happened to carry a stale header.
      return;
    }

    resolved.set(exchange, caller);
    exchange.provenance = exchange.provenance.withActor(
      unwrap(Actor.user(caller.user.id)),
    );
  };
}

/** What position 6 resolved, if anything. */
export function callerOf(exchange: Exchange): Caller | undefined {
  return resolved.get(exchange);
}
