/**
 * `conditional`'s `Validators`, implemented. **`identity` transport.**
 *
 * **This interface has had no implementer since it shipped**, which was the
 * point: `conditional` left it open so the first aggregate would meet its
 * obligation at the moment it was written rather than discover it afterwards.
 * This is that moment, and the shape held — with one thing worth recording.
 *
 * **The tag is over the representation, not over the version.** `User.version`
 * bumps on every mutation and would have made a perfectly serviceable
 * validator, but a version number is an *entity* identity and an ETag is a
 * *representation* identity. Two variants of one user at the same version must
 * not share a tag, and only the representation knows which variant it is. So
 * this hashes the same view the route returns, through the canonical JSON the
 * repository already had — which is what makes the tag **strong** rather than
 * weak, and a strong tag is what `If-Match` requires.
 *
 * See `notes/domain/identity.md`.
 */

import { type Exchange } from '../../../../shared/edge/index.js';
import {
  type Validator,
  type Validators,
  strongTagFor,
} from '../../../../shared/conditional/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import { userId } from '../../domain/index.js';
import { type Users } from '../../app/ports.js';
import { type Caller, resolveCaller } from '../../app/query/caller.js';
import { userView } from './views.js';

export interface ValidatorOptions {
  readonly users: Users;
  /** The same resolution the router does, so the two cannot disagree. */
  readonly resolve: (token: string) => Promise<Caller>;
}

/**
 * The media type a representation was served as, from `Accept`.
 *
 * Crude on purpose: this repository serves one variant. The point is that the
 * variant is **in the tag** rather than assumed away, so adding a CSV export
 * later changes what this returns and not what the tag means.
 */
function variantOf(exchange: Exchange): string {
  const accept = exchange.request.headers['accept'] ?? 'application/json';
  return accept.split(',')[0]?.trim() ?? 'application/json';
}

/**
 * Supply the current validator for the representation this request addresses.
 *
 * `undefined` for anything this context does not tag — which is most routes,
 * and is what gives `If-Match: *` its create-only meaning where it applies.
 */
export function identityValidators(options: ValidatorOptions): Validators {
  return async (exchange: Exchange): Promise<Validator | undefined> => {
    // `/v1/me` and `/v1/users/{id}` — the two routes that render a user. A
    // route table driving this is the natural next step and belongs with
    // `openapi`, which walks the same registry.
    const path = exchange.request.path;
    const detail = /^\/v1\/users\/([^/]+)$/.exec(path);
    if (!path.startsWith('/v1/me') && detail === null) return undefined;

    const authorization = exchange.request.headers['authorization'] ?? '';
    const token = authorization.split(' ')[1];
    // No token is not a precondition failure — position 6 already refused, or
    // the route is public. Untagged is the honest answer.
    if (token === undefined || token === '') return undefined;

    let caller: Caller;
    try {
      caller = await options.resolve(token);
    } catch {
      return undefined;
    }

    // **The addressed user, not the caller.** `PATCH /v1/users/{id}` is the
    // route an administrator uses on somebody else, and tagging it with the
    // caller's own representation would compare an `If-Match` against the wrong
    // resource entirely — a precondition that passes when it should fail.
    const target =
      detail?.[1] === undefined ? caller.user.id : userId(detail[1]);
    const fresh = await options.users.byId(target);
    if (fresh === undefined) return undefined;

    return {
      etag: unwrap(strongTagFor(variantOf(exchange), userView(fresh))),
      lastModified: fresh.updatedAt,
    };
  };
}

export { resolveCaller };
