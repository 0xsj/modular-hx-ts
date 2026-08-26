/**
 * `orgs` on the shared registry. **`orgs` transport.**
 *
 * `CONFORMANCE.md` §3.5: `/v1/<resource>`, and a context does not appear in a
 * path. **Organizations are a resource**, with memberships and invitations
 * beneath them.
 *
 * §3.5\'s table does not name these routes — it settles `identity` and `audit`.
 * They are reported to the collection as **constant-set routes the table is
 * missing** rather than quietly kept, because a route no sibling shares is
 * surface no case can be written against.
 *
 * **Authorization is per organization, and it lives in `app/authorize.ts`.**
 * Nothing here consults an account role, and that omission is the point: an
 * `identity` administrator is not an owner of somebody else\'s organization.
 *
 * See `notes/domain/orgs.md`.
 */

import { z } from 'zod';
import { type Subject } from '../../../../shared/authz/index.js';
import { type Exchange, json, text } from '../../../../shared/edge/index.js';
import { internal, unauthenticated } from '../../../../shared/errors/index.js';
import {
  type AnyRoute,
  router,
  routesFor,
} from '../../../../shared/httproute/index.js';
import {
  Carrier,
  type Provenance,
} from '../../../../shared/provenance/index.js';
import { orgId, orgRole } from '../../domain/index.js';
import { type OrgsDeps } from '../../app/ports.js';
import {
  archiveOrg,
  foundOrg,
  renameOrg,
} from '../../app/command/organizations.js';
import {
  changeRole,
  leaveOrg,
  removeMember,
} from '../../app/command/memberships.js';
import {
  acceptInvitation,
  invite,
  revokeInvitation,
} from '../../app/command/invitations.js';
import {
  myOrgs,
  readOrg,
  readPending,
  readRoster,
} from '../../app/query/read.js';
import { invitationView, memberView, orgView } from './views.js';

const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
});

const OrgReply = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.enum(['active', 'archived']),
  your_role: z.enum(['owner', 'admin', 'member']).optional(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

const MemberReply = z.object({
  id: z.string(),
  user_id: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  joined_at: z.string(),
});

const InvitationReply = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(['owner', 'admin', 'member']),
  invited_by: z.string(),
  expires_at: z.string(),
});

const FoundBody = z
  .object({ name: z.string(), slug: z.string().optional() })
  .strict();
const RenameBody = z.object({ name: z.string() }).strict();
const InviteBody = z.object({ email: z.string(), role: z.string() }).strict();
const AcceptBody = z.object({ token: z.string() }).strict();
const RoleBody = z.object({ role: z.string() }).strict();

/** Bound once, so every route infers its body from its own schema. */
const route = routesFor<Subject>();

export type OrgRoute = AnyRoute<Subject>;

export interface OrgRoutesOptions {
  readonly deps: OrgsDeps;
  /**
   * The caller, as an authz `Subject`.
   *
   * Supplied by the composition root from `identity`\'s authenticated caller —
   * `CONTEXTS.md` §3, the same seam `audit` uses. This context never sees a
   * token, which is what lets it know *who* without importing the context that
   * decides.
   */
  readonly caller: (exchange: Exchange) => Subject | undefined;
  readonly onUndeclared?: (
    route: { method: string; path: string },
    status: number,
  ) => void;
}

/** Present because every route declares `auth: 'required'`. */
function must(caller: Subject | undefined): Subject {
  if (caller === undefined) {
    throw unauthenticated('this request requires authentication');
  }
  return caller;
}

/**
 * The ambient provenance, read at the boundary — `PROVENANCE.md`.
 *
 * Absent means the routes were mounted without the chain above them, which is a
 * wiring error rather than a runtime condition: it would otherwise surface as
 * an event with no correlation id, invisible until somebody tried to trace a
 * request.
 */
function provenance(): Provenance {
  const current = Carrier.current();
  if (current === undefined) {
    throw internal('orgs routes must be mounted behind the httpx chain');
  }
  return current;
}

/**
 * Statuses the chain adds under this context\'s name — `S11`.
 *
 * Declared per route rather than merged in, because the declaration is what
 * `openapi` publishes as the contract and a status the chain can produce is a
 * status the contract has to name.
 */
const AUTHED = { 401: Problem, 403: Problem, 429: Problem } as const;
const MUTATING = { ...AUTHED, 409: Problem, 422: Problem } as const;

export function orgRoutes(options: OrgRoutesOptions): readonly OrgRoute[] {
  const { deps } = options;

  return [
    route({
      method: 'GET',
      path: '/v1/orgs',
      summary: 'The organizations you belong to',
      replies: { 200: z.array(OrgReply), ...AUTHED },
      auth: 'required',
      async handle({ caller }) {
        const mine = await myOrgs(deps, must(caller));
        return json(
          200,
          mine.map((org) => orgView(org)),
        );
      },
    }),

    route({
      method: 'POST',
      path: '/v1/orgs',
      summary: 'Found an organization',
      body: FoundBody,
      replies: { 201: OrgReply, 400: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, body }) {
        const org = await foundOrg(
          deps,
          must(caller),
          {
            name: body.name,
            ...(body.slug === undefined ? {} : { slug: body.slug }),
          },
          provenance(),
        );
        // The founder is its first owner, in the same transaction.
        return json(201, orgView(org, 'owner'));
      },
    }),

    route({
      method: 'GET',
      path: '/v1/orgs/:id',
      summary: 'One organization',
      // 304 and 412 because the route is `validated` — position 9 answers
      // both under this route's name, and S11 makes an undeclared status a
      // published contract that lies.
      replies: {
        200: OrgReply,
        304: z.null(),
        404: Problem,
        412: Problem,
        ...AUTHED,
      },
      auth: 'required',
      validated: true,
      async handle({ caller, params }) {
        const { org, role } = await readOrg(
          deps,
          must(caller),
          orgId(params['id'] ?? ''),
        );
        return json(200, orgView(org, role));
      },
    }),

    route({
      method: 'PATCH',
      path: '/v1/orgs/:id',
      summary: 'Rename an organization',
      body: RenameBody,
      replies: {
        200: OrgReply,
        400: Problem,
        404: Problem,
        412: Problem,
        ...MUTATING,
      },
      auth: 'required',
      validated: true,
      async handle({ caller, params, body }) {
        const org = await renameOrg(
          deps,
          must(caller),
          { org: orgId(params['id'] ?? ''), name: body.name },
          provenance(),
        );
        return json(200, orgView(org));
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/orgs/:id',
      summary: 'Archive an organization',
      replies: { 200: OrgReply, 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        // **Archive, not delete**, and the method is the honest lie: `DELETE`
        // is what a client means and the memberships, the audit trail and the
        // slug all stay. Releasing the slug would let somebody take the name of
        // an organization whose records still exist.
        const org = await archiveOrg(
          deps,
          must(caller),
          orgId(params['id'] ?? ''),
          provenance(),
        );
        return json(200, orgView(org));
      },
    }),

    route({
      method: 'GET',
      path: '/v1/orgs/:id/members',
      summary: 'The roster',
      replies: { 200: z.array(MemberReply), 404: Problem, ...AUTHED },
      auth: 'required',
      async handle({ caller, params }) {
        const roster = await readRoster(
          deps,
          must(caller),
          orgId(params['id'] ?? ''),
        );
        return json(200, roster.map(memberView));
      },
    }),

    route({
      method: 'PUT',
      path: '/v1/orgs/:id/members/:userId/role',
      summary: 'Change a member`s role in this organization',
      body: RoleBody,
      replies: { 200: MemberReply, 400: Problem, 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params, body }) {
        const membership = await changeRole(
          deps,
          must(caller),
          {
            org: orgId(params['id'] ?? ''),
            userId: params['userId'] ?? '',
            role: orgRole(body.role),
          },
          provenance(),
        );
        return json(200, memberView(membership));
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/orgs/:id/members/:userId',
      summary: 'Remove a member',
      replies: { 204: z.null(), 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        await removeMember(
          deps,
          must(caller),
          {
            org: orgId(params['id'] ?? ''),
            userId: params['userId'] ?? '',
          },
          provenance(),
        );
        return text(204, '');
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/orgs/:id/members/me',
      summary: 'Leave an organization',
      replies: { 204: z.null(), 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        await leaveOrg(
          deps,
          must(caller),
          orgId(params['id'] ?? ''),
          provenance(),
        );
        return text(204, '');
      },
    }),

    route({
      method: 'GET',
      path: '/v1/orgs/:id/invitations',
      summary: 'Outstanding invitations',
      replies: { 200: z.array(InvitationReply), 404: Problem, ...AUTHED },
      auth: 'required',
      async handle({ caller, params }) {
        const pending = await readPending(
          deps,
          must(caller),
          orgId(params['id'] ?? ''),
        );
        return json(200, pending.map(invitationView));
      },
    }),

    route({
      method: 'POST',
      path: '/v1/orgs/:id/invitations',
      summary: 'Invite somebody by email',
      body: InviteBody,
      // **202 and nothing that distinguishes addresses.** The same rule
      // conformance case 15 fixes for `identity`: an invitation to an address
      // that already has an account and one that does not answer identically,
      // or the endpoint is an account-existence oracle for anybody who can
      // invite.
      replies: { 202: z.null(), 400: Problem, 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params, body }) {
        await invite(
          deps,
          must(caller),
          {
            org: orgId(params['id'] ?? ''),
            email: body.email,
            role: orgRole(body.role),
          },
          provenance(),
        );
        return text(202, '');
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/orgs/:id/invitations/:invitationId',
      summary: 'Withdraw an invitation',
      replies: { 204: z.null(), 404: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, params }) {
        await revokeInvitation(
          deps,
          must(caller),
          {
            org: orgId(params['id'] ?? ''),
            invitation: params['invitationId'] ?? '',
          },
          provenance(),
        );
        return text(204, '');
      },
    }),

    route({
      method: 'POST',
      path: '/v1/invitations/accept',
      summary: 'Accept an invitation',
      body: AcceptBody,
      // **The token is in the body and never in the URL** — §3.5\'s rule for
      // `identity`\'s links, and the reason is the same one: URLs reach access
      // logs, referrer headers and browser history, and a single-use secret
      // that leaks into any of the three is spent before its owner clicks it.
      //
      // **Not under `/v1/orgs/{id}`**, because the acceptor does not know the
      // id — the token does. Requiring one would put the organization in the
      // link, which is the thing the tag exists to bind privately.
      replies: { 200: MemberReply, 400: Problem, ...MUTATING },
      auth: 'required',
      async handle({ caller, body }) {
        const membership = await acceptInvitation(
          deps,
          must(caller),
          body.token,
          provenance(),
        );
        return json(200, memberView(membership));
      },
    }),
  ];
}

export function orgRouter(options: OrgRoutesOptions) {
  return router<Subject>({
    routes: orgRoutes(options),
    caller: options.caller,
    ...(options.onUndeclared === undefined
      ? {}
      : { onUndeclared: options.onUndeclared }),
  });
}
