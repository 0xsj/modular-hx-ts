/**
 * List and read users. **`identity` app · query.** `CONFORMANCE.md` §3.5.
 *
 * Thirteen conformance cases need these — every pagination case, every
 * transport case, the authz case and the concurrency case — and users are the
 * only resource every blueprint ships.
 *
 * **Keyset, never offset.** Offset re-scans everything before the page, drifts
 * under concurrent inserts, and gives a client page numbers that stop meaning
 * anything the moment a row is added. The key is `(created_at, id)`, which is
 * total where `created_at` alone is not.
 *
 * See `notes/domain/identity.md`.
 */

import {
  type Authorizer,
  type Subject,
} from '../../../../shared/authz/index.js';
import {
  forbidden,
  invalid,
  notFound,
} from '../../../../shared/errors/index.js';
import {
  type Cursor,
  DEFAULT_LIMITS,
  decodeCursor,
  encodeCursor,
  resolveLimit,
} from '../../../../shared/pagination/index.js';
import { isErr, unwrap } from '../../../../shared/result/index.js';
import { type User, userId } from '../../domain/index.js';
import { type Users } from '../ports.js';

export interface ListDeps {
  readonly users: Users;
  readonly authorizer: Authorizer;
}

/**
 * `type:verb`, matching the resource — `authz` §subject.
 *
 * A **separate action from reading one user**, because they are different
 * exposures: a directory listing hands over every address at once, and a
 * detail read hands over one the caller already knew to ask for.
 */
export const LIST_USERS = 'user:list';

/**
 * The ordering a cursor belongs to.
 *
 * Carried inside the cursor, so one issued against an unfiltered listing cannot
 * be replayed against a filtered one — conformance case 33, where the same
 * position would mean a different row. The filter is part of the identity of
 * the listing, so it is part of the ordering name.
 */
function orderingFor(q: string | undefined): string {
  return `users.created_at.asc:${q ?? ''}`;
}

/** Where a page starts, and which way it runs. */
interface Position {
  readonly at: string;
  readonly id: string;
  readonly back: boolean;
}

export interface ListInput {
  readonly q?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface UserPage {
  readonly items: readonly User[];
  readonly next?: string;
  readonly prev?: string;
}

export async function listUsers(
  deps: ListDeps,
  subject: Subject,
  input: ListInput,
): Promise<UserPage> {
  // **Read, not merely present.** `M4` requires the parameter; this requires
  // the permission — an unwired policy refuses, because `denyAll` is the
  // default authorizer.
  const decision = deps.authorizer.allow(subject, LIST_USERS, {
    type: 'user',
    id: '*',
  });
  if (!decision.allowed) throw forbidden(`not permitted: ${decision.reason}`);

  // Clamps rather than refuses: a client asking for 10 000 gets the maximum,
  // because a page size is a hint and a refusal here teaches nothing.
  const limit = resolveLimit(input.limit, DEFAULT_LIMITS);

  const ordering = orderingFor(input.q);
  const position =
    input.cursor === undefined ? undefined : read(ordering, input.cursor);

  const rows = await deps.users.list({
    ...(input.q === undefined ? {} : { q: input.q }),
    limit,
    ...(position === undefined
      ? {}
      : position.back
        ? { before: { createdAt: new Date(position.at), id: position.id } }
        : { after: { createdAt: new Date(position.at), id: position.id } }),
  });

  // The adapter over-fetched by one. The overshoot is how *is there more* is
  // answered without a second count over the same predicate.
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  // A backward page came back descending, because reversing it in the adapter
  // would answer in an order the query did not ask for.
  const items = position?.back === true ? [...page].reverse() : page;

  const first = items[0];
  const last = items.at(-1);

  // **`next` is absent on the last page and `prev` on the first**, which is
  // what a client renders its controls from. On a backward page the roles swap:
  // the overshoot proves there is more *behind*, not ahead.
  // A backward page always has somewhere to go forward to — it was reached
  // from there.
  const backward = position?.back === true;
  const hasNext = backward || more;
  const hasPrev = backward ? more : position !== undefined;

  return {
    items,
    ...(hasNext && last !== undefined
      ? { next: cursorAt(ordering, last, false) }
      : {}),
    ...(hasPrev && first !== undefined
      ? { prev: cursorAt(ordering, first, true) }
      : {}),
  };
}

function cursorAt(ordering: string, user: User, back: boolean): string {
  return unwrap(
    encodeCursor(ordering, {
      at: user.createdAt.toISOString(),
      id: user.id,
      back,
    }),
  );
}

function read(ordering: string, raw: string): Position {
  const decoded = decodeCursor(ordering, raw as Cursor);
  if (isErr(decoded)) {
    // **`invalid-cursor`, and it is in the catalogue** — §3.5. A client
    // branching on `type` recovers by dropping the cursor and asking for the
    // first page; it cannot do that from a bare 400.
    throw invalid('this cursor cannot be used for this listing', [], {
      problem: 'invalid-cursor',
    });
  }

  const value = decoded.value as Partial<Position>;
  if (typeof value.at !== 'string' || typeof value.id !== 'string') {
    throw invalid('this cursor cannot be used for this listing', [], {
      problem: 'invalid-cursor',
    });
  }
  return { at: value.at, id: value.id, back: value.back === true };
}

export async function getUser(
  deps: ListDeps,
  subject: Subject,
  id: string,
): Promise<User> {
  const decision = deps.authorizer.allow(subject, LIST_USERS, {
    type: 'user',
    id,
    // A user owns themselves, so an `own`-scoped grant reads your own record
    // and nobody else's — which is the shape `orgs` will need.
    ownerId: id,
  });
  if (!decision.allowed) throw forbidden(`not permitted: ${decision.reason}`);

  const found = await deps.users.byId(userId(id));
  // **404, never 403.** A 403 confirms the id exists and turns any id into an
  // oracle — conformance case 23, and the same rule `tenant` follows.
  if (found === undefined) throw notFound('no such user');
  return found;
}
