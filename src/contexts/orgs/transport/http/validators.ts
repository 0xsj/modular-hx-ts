/**
 * `conditional`\'s `Validators`, for organizations. **`orgs` transport.**
 *
 * **The second implementer, and it found the gap the first could not.**
 * `conditional` takes **one** `Validators` function, and until this context
 * existed there was exactly one implementer, so the root passed it straight
 * through. Two contexts cannot both be *the* one — see `src/wire.ts`, which
 * composes them.
 *
 * That gap was invisible while everything was green: `orgs` declared
 * `validated: true` on two routes, `S11` correctly required them to declare
 * 304 and 412, and **nothing supplied a tag**, so neither status could ever be
 * produced. A declaration nothing implements is the same failure as a route
 * nothing mounts, and it looks exactly like working software.
 *
 * The tag is over the **representation** — decision 0003\'s rule, applied
 * again: a version number is an *entity* identity and an ETag is a
 * *representation* identity, so two variants of one organization at the same
 * version must not share a tag.
 *
 * See `notes/domain/orgs.md`.
 */

import {
  type Validator,
  type Validators,
  strongTagFor,
} from '../../../../shared/conditional/index.js';
import { type Exchange } from '../../../../shared/edge/index.js';
import { type Subject, subjectId } from '../../../../shared/authz/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import { orgId } from '../../domain/index.js';
import { type Memberships, type Organizations } from '../../app/ports.js';
import { orgView } from './views.js';

export interface ValidatorOptions {
  readonly orgs: Organizations;
  readonly memberships: Memberships;
  /** The caller, from position 6. The same function the router uses. */
  readonly caller: (exchange: Exchange) => Subject | undefined;
}

/** The variant a request addresses, so two of them cannot share a tag. */
function variantOf(exchange: Exchange): string {
  const accept = exchange.request.headers['accept'] ?? 'application/json';
  return accept.split(',')[0]?.trim() ?? 'application/json';
}

export function orgValidators(options: ValidatorOptions): Validators {
  return async (exchange: Exchange): Promise<Validator | undefined> => {
    const detail = /^\/v1\/orgs\/([^/]+)$/.exec(exchange.request.path);
    if (detail?.[1] === undefined) return undefined;

    const caller = options.caller(exchange);
    // No caller is not a precondition failure — position 6 already refused, or
    // the route is public. Untagged is the honest answer.
    if (caller === undefined) return undefined;

    const id = orgId(detail[1]);
    // **The caller\'s own role is in the view**, so the tag has to be computed
    // for *this* caller. Two members with different roles see two different
    // representations of one organization, and a shared tag would serve one of
    // them the other\'s.
    const membership = await options.memberships.of(id, subjectId(caller));
    if (membership === undefined) return undefined;

    const org = await options.orgs.byId(id);
    if (org === undefined) return undefined;

    return {
      etag: unwrap(
        strongTagFor(variantOf(exchange), orgView(org, membership.role)),
      ),
      lastModified: org.updatedAt,
    };
  };
}
