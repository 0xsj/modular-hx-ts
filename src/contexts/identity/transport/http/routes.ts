/**
 * `identity`'s HTTP surface. **Conformance cases 5–11.**
 *
 * Every route declares its request and response schemas here and the dispatcher
 * validates from that declaration — `CONTEXTS.md` §8 step 5, one source and
 * never two.
 *
 * See `notes/domain/identity.md`.
 */

import { z } from 'zod';
import { json, text } from '../../../../shared/edge/index.js';
import {
  AppError,
  Kind,
  forbidden,
  internal,
  unauthenticated,
} from '../../../../shared/errors/index.js';
import {
  type Provenance,
  Actor,
  Carrier,
} from '../../../../shared/provenance/index.js';
import { type Subject, subject } from '../../../../shared/authz/index.js';
import { unwrap } from '../../../../shared/result/index.js';
import { type Caller } from '../../app/query/caller.js';
import { changePassword } from '../../app/command/change-password.js';
import { grantRole, revokeRole } from '../../app/command/roles.js';
import {
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../../app/command/apikeys.js';
import { consumeLink, requestChallenge } from '../../app/command/challenges.js';
import { login } from '../../app/command/login.js';
import { register } from '../../app/command/register.js';
import { updateUser } from '../../app/command/update-user.js';
import { getUser, listUsers } from '../../app/query/list-users.js';
import { revokeOne } from '../../app/command/sessions.js';
import { type IdentityApp } from '../../app/index.js';
import {
  type AnyRoute,
  routesFor,
} from '../../../../shared/httproute/index.js';
import {
  type Role,
  type Session,
  Purpose,
  apiKeyId,
  role,
  userId,
} from '../../domain/index.js';
import { userView } from './views.js';

// --- schemas ---------------------------------------------------------------
//
// Declared once. The dispatcher parses with them and `openapi` will render
// them; neither reads a handler.

/**
 * **The specified payload, and nothing more** — `CONFORMANCE.md` §3.5.
 *
 * Not `roles`, not `status`. A register endpoint honouring a role from the body
 * is the privilege escalation §4.3 spends a section on; roles reach a user
 * through `POST /v1/users/{id}/roles`, called by somebody who already holds
 * one, and the first such somebody comes from `seed`. `strict()` refuses the
 * extra field rather than ignoring it, so a client sending `roles` learns that
 * it did nothing instead of believing it worked.
 */
const RegisterBody = z
  .object({
    email: z.string(),
    password: z.string().optional(),
    display_name: z.string().optional(),
  })
  .strict();

const LoginBody = z.object({
  email: z.string(),
  password: z.string(),
});

const ChangePasswordBody = z.object({
  current_password: z.string(),
  new_password: z.string(),
});

const GrantRoleBody = z.object({ role: z.string() }).strict();

/** `PATCH /v1/users/{id}` — every field optional, `If-Match` required. */
const PatchUserBody = z
  .object({
    email: z.string().optional(),
    display_name: z.string().nullable().optional(),
    // **Enable and disable live here**, not on sub-resource verbs — §3.5. The
    // route already carries `If-Match`, and the domain's `Disable`/`Enable` are
    // already idempotent, so two RPC-shaped paths would buy nothing.
    status: z.enum(['active', 'disabled']).optional(),
  })
  .strict();

const UserReply = z.object({
  id: z.string(),
  email: z.string(),
  display_name: z.string().optional(),
  roles: z.array(z.string()),
  status: z.enum(['active', 'disabled']),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** A keyset page. `items` is never `null` — conformance case 32. */
const PageReply = z.object({
  items: z.array(UserReply),
  cursor: z.object({
    next: z.string().optional(),
    prev: z.string().optional(),
  }),
});

const TokenReply = z.object({
  // Conformance case 6: a bearer token, its type, an expiry, and the user and
  // session ids.
  //
  // **`access_token`, and the cases interpolate it sixty times.** These were
  // camelCase — idiomatic TypeScript, and the wrong axis: the wire is a
  // contract shared with a Go and a Python sibling, and §3.5 makes it
  // normative precisely so a client cannot tell which one it reached.
  access_token: z.string(),
  token_type: z.literal('Bearer'),
  expires_at: z.string(),
  user_id: z.string(),
  session_id: z.string(),
});

/**
 * One route for every emailed secret — `CONFORMANCE.md` §3.5's `POST /v1/links`.
 *
 * The purpose is **in the body** because it is a property of the link being
 * asked for, not a resource of its own; four paths differing only by a slug were
 * four ways to spell one request.
 */
const RequestLinkBody = z.object({
  purpose: z.enum([
    'verify_email',
    'reset_password',
    'magic_link',
    'change_email',
  ]),
  email: z.string(),
  /** `change_email` carries the new address; the others carry nothing. */
  newEmail: z.string().optional(),
});

/** The wire spelling of a purpose, mapped to the domain's. */
const PURPOSES = {
  verify_email: Purpose.VerifyEmail,
  reset_password: Purpose.ResetPassword,
  magic_link: Purpose.MagicLink,
  change_email: Purpose.ChangeEmail,
} as const;

/**
 * One body for every purpose.
 *
 * `password` is present only for a reset, and a token that needs one without
 * one gets case 13's single indistinguishable refusal — the same answer an
 * expired token gets, which is the whole point of that case.
 */
const ConsumeBody = z
  .object({
    token: z.string(),
    password: z.string().optional(),
  })
  .strict();

const CreateKeyBody = z.object({
  name: z.string(),
  scopes: z.array(z.string()),
});

const CreatedKeyReply = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  /** **Present exactly once, on the creation response.** Case 16. */
  secret: z.string(),
});

const KeyReply = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
});

const RolesReply = z.object({
  roles: z.array(z.string()),
  version: z.number(),
});

const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  detail: z.string(),
});

/**
 * The `Subject` an authorization decision is made against.
 *
 * **Built at the boundary and passed explicitly** — `ARCHITECTURE.md` §3 rule 6
 * and `authz`'s own rule. Never read from ambient state inside a use case, so a
 * command's signature says what it needs in order to decide.
 *
 * Roles come from the user this request just resolved, which is what makes
 * conformance case 12 true: a grant lands in the store, and the next request
 * reads it here.
 */
export function subjectOf(caller: Caller): Subject {
  return subject({
    actor: unwrap(Actor.user(caller.user.id)),
    // **The owner's roles, always** — even when an API key is presenting.
    roles: [...caller.user.roles],
    // **And the key's scopes, when there is one.** Conformance case 17: the
    // effective permission is the *intersection*, so a scope can only subtract.
    // `authz` computes that; this just hands it both halves. Building the
    // subject from the key's scopes *instead of* the owner's roles would make a
    // scope a grant, which is the case inverted.
    ...(caller.apiKey === undefined
      ? {}
      : { scopes: [...caller.apiKey.scopes] }),
    // Single-tenant until `orgs` lands. `tenant`'s own rule: single mode is
    // byte-identical to no tenancy.
    tenant: 'default',
  });
}

/**
 * A caller with a **session**.
 *
 * The registry already refused an API key on every route that does not opt in,
 * so reaching this with one is impossible — but the type says so too, which is
 * how conformance case 16 stopped being something to remember. Every route that
 * needs `caller.session` has to say it, and saying it is the refusal.
 */
function mustSession(
  caller: Caller | undefined,
): Caller & { session: Session } {
  const present = must(caller);
  if (present.session === undefined) {
    throw forbidden('this endpoint requires a session, not an API key');
  }
  return present as Caller & { session: Session };
}

/** The caller, or a refusal. Present exactly when the route required auth. */
function must(caller: Caller | undefined): Caller {
  if (caller === undefined) {
    // Unreachable through the dispatcher, which resolves before dispatching.
    // A guard rather than a `!`, because the day it *is* reachable is the day
    // somebody adds a route and writes `anonymous` by mistake.
    throw unauthenticated('a bearer token is required');
  }
  return caller;
}

/** Bound once, so every route below infers its body from its own schema. */
const route = routesFor<Caller>();

export interface RoutesOptions {
  /**
   * What a self-registered user gets.
   *
   * **A product decision, so it arrives from the composition root** — the
   * context knows how to hold roles and enforces what they permit, and *which*
   * ones a signup confers belongs to whoever compiled the policy. It is not on
   * `RegisterBody`: an anonymous request naming its own roles is privilege
   * escalation with extra steps.
   */
  readonly defaultRoles: readonly Role[];
}

export function identityRoutes(
  app: IdentityApp,
  options: RoutesOptions,
): readonly AnyRoute<Caller>[] {
  return [
    route({
      method: 'POST',
      path: '/v1/users',
      summary: 'Register a user',
      body: RegisterBody,
      replies: { 201: UserReply, 400: Problem, 409: Problem },
      auth: 'anonymous',
      async handle({ body }) {
        // Case 5: creates an **active** user and returns its identifier.
        const user = await register(
          app.deps,
          anonymousSubject(),
          {
            ...body,
            // **An empty password is the wire spelling of absent**, not an
            // eight-character violation. §2.2: a user is not their
            // credentials, and `PasswordHash` already models *no password* —
            // an account created for somebody to claim later. Sending `""`
            // and getting *is too short* is the boundary contradicting the
            // domain, and it is what stopped the conformance corpus loading.
            ...(body.password === undefined || body.password === ''
              ? { password: undefined }
              : { password: body.password }),
            ...(body.display_name === undefined
              ? {}
              : { displayName: body.display_name }),
            roles: options.defaultRoles,
          },
          provenance(),
        );
        return json(201, userView(user));
      },
    }),

    route({
      method: 'POST',
      path: '/v1/sessions',
      summary: 'Log in',
      body: LoginBody,
      // **No 404 and no 422 here, deliberately.** Case 7: wrong password and
      // unknown address return the identical response, so this route has
      // exactly one failure status.
      replies: { 201: TokenReply, 401: Problem, 400: Problem },
      auth: 'anonymous',
      async handle({ body }) {
        const { session, token } = await login(
          app.deps,
          anonymousSubject(),
          body,
          provenance(),
        );

        return json(201, {
          access_token: token,
          token_type: 'Bearer',
          expires_at: session.expiresAt.toISOString(),
          user_id: session.userId,
          session_id: session.id,
        });
      },
    }),

    // --- users: the list and detail routes §3.5 makes non-optional -----------
    //
    // Thirteen conformance cases need these — every pagination case, every
    // transport case, the authz case and the concurrency case. They were
    // reported as an unwritten slice, which was an accurate read of an
    // incomplete spec and is no longer one.

    route({
      method: 'GET',
      path: '/v1/users',
      summary: 'List users',
      replies: {
        200: PageReply,
        400: Problem,
        401: Problem,
        403: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller, query }) {
        const page = await listUsers(app.deps, subjectOf(must(caller)), {
          q: query['q'],
          // A query string is strings; the coercion belongs here rather than in
          // the query, which should not know it was reached over HTTP.
          limit:
            query['limit'] === undefined ? undefined : Number(query['limit']),
          cursor: query['cursor'],
        });

        return json(200, {
          // **`items` is an array, never null** — conformance case 32. Null and
          // `[]` are the same to a careless server and different to every
          // client: one renders an empty state, the other crashes.
          items: page.items.map(userView),
          cursor: {
            ...(page.next === undefined ? {} : { next: page.next }),
            ...(page.prev === undefined ? {} : { prev: page.prev }),
          },
        });
      },
    }),

    route({
      method: 'GET',
      path: '/v1/users/:id',
      summary: 'One user',
      replies: {
        200: UserReply,
        304: z.null(),
        401: Problem,
        403: Problem,
        404: Problem,
        412: Problem,
        429: Problem,
      },
      auth: 'required',
      // Carries an ETag, which is what `PATCH` below requires an `If-Match`
      // against — the pair is the concurrency case.
      validated: true,
      async handle({ caller, params }) {
        const found = await getUser(
          app.deps,
          subjectOf(must(caller)),
          params['id'] ?? '',
        );
        return json(200, userView(found));
      },
    }),

    route({
      method: 'PATCH',
      path: '/v1/users/:id',
      summary: 'Update a user',
      body: PatchUserBody,
      // **`If-Match` required**, which is why 428 is here: a mutating request
      // with no precondition is not a request this route will guess at.
      // Conformance case 29 is the stale-validator half.
      replies: {
        200: UserReply,
        400: Problem,
        401: Problem,
        403: Problem,
        404: Problem,
        409: Problem,
        412: Problem,
        422: Problem,
        428: Problem,
        429: Problem,
      },
      auth: 'required',
      validated: true,
      async handle({ caller, params, body, exchange }) {
        requirePrecondition(exchange.request.headers);

        const updated = await updateUser(
          app.deps,
          subjectOf(must(caller)),
          {
            target: userId(params['id'] ?? ''),
            ...(body.email === undefined ? {} : { email: body.email }),
            ...(body.display_name === undefined
              ? {}
              : { displayName: body.display_name }),
            ...(body.status === undefined ? {} : { status: body.status }),
          },
          provenance(),
        );
        return json(200, userView(updated));
      },
    }),

    route({
      method: 'GET',
      path: '/v1/me',
      summary: 'The authenticated caller',
      replies: {
        200: UserReply,
        401: Problem,
        304: z.null(),
        403: Problem,
        412: Problem,
        429: Problem,
      },
      auth: 'required',
      // **The one route a key may reach**, so there is somewhere to observe
      // that a key acts as its owner — narrowed by its scopes (case 17).
      meta: { apiKeys: 'allowed' },
      // Case 30's half of `conditional`: a GET carries an `ETag`.
      validated: true,
      handle({ caller }) {
        // Case 8. The roles on this view are read **now**, per request, which
        // is what makes case 12 true without any cache to invalidate.
        return Promise.resolve(json(200, userView(must(caller).user)));
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/sessions/current',
      summary: 'Log out',
      replies: {
        204: z.null(),
        401: Problem,
        403: Problem,
        409: Problem,
        422: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller }) {
        // Case 10: revokes the current session; reusing that token afterwards
        // is 401, which `resolveCaller` enforces on the next request.
        const { session } = mustSession(caller);
        await app.deps.transactor.within((work) =>
          revokeOne(
            work,
            app.deps,
            subjectOf(mustSession(caller)),
            session.id,
            'logout',
            provenance(),
          ),
        );
        return text(204, '');
      },
    }),

    // --- API keys: cases 16, 17 ---------------------------------------------
    //
    // None of these declares `apiKeys: 'allowed'`, so a key is refused on all
    // of them — which is case 16's *refused on key management* with no code.

    route({
      method: 'POST',
      path: '/v1/me/keys',
      summary: 'Create an API key',
      body: CreateKeyBody,
      replies: {
        201: CreatedKeyReply,
        400: Problem,
        401: Problem,
        403: Problem,
        409: Problem,
        422: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller, body }) {
        const { user } = must(caller);
        const created = await createApiKey(
          app.deps,
          subjectOf(must(caller)),
          { owner: user.id, name: body.name, scopes: body.scopes },
          provenance(),
        );

        // **The only moment the secret exists outside the caller's hands.**
        return json(201, {
          id: created.key.id,
          name: created.key.name,
          scopes: [...created.key.scopes],
          secret: created.secret,
        });
      },
    }),

    route({
      method: 'GET',
      path: '/v1/me/keys',
      summary: 'List the caller`s API keys',
      replies: {
        200: z.array(KeyReply),
        401: Problem,
        403: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller }) {
        const { user } = must(caller);
        const keys = await listApiKeys(
          app.deps,
          subjectOf(must(caller)),
          user.id,
        );
        // **No secret, and none to give.** The store holds a fingerprint.
        return json(
          200,
          keys.map((key) => ({
            id: key.id,
            name: key.name,
            scopes: [...key.scopes],
            createdAt: key.createdAt.toISOString(),
            revokedAt: key.revokedAt?.toISOString() ?? null,
          })),
        );
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/me/keys/:id',
      summary: 'Revoke an API key',
      replies: {
        204: z.null(),
        401: Problem,
        403: Problem,
        404: Problem,
        409: Problem,
        422: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller, params }) {
        const { user } = must(caller);
        await revokeApiKey(
          app.deps,
          subjectOf(must(caller)),
          user.id,
          apiKeyId(params['id'] ?? ''),
          provenance(),
        );
        return text(204, '');
      },
    }),

    // --- challenges: cases 13, 14, 15 ---------------------------------------

    route({
      method: 'POST',
      path: '/v1/links',
      summary: 'Request an emailed secret',
      body: RequestLinkBody,
      // **202 and nothing else on the anonymous purposes.** Case 15: an unknown
      // address returns the same answer as a known one, so there is no failure
      // status to distinguish them with. `change_email` adds a 401, because it
      // is the one purpose that acts on an account the caller already holds.
      replies: { 202: z.null(), 400: Problem, 401: Problem },
      // **Declared anonymous and checked in the handler**, which is the shape
      // `httproute`'s note describes for a route serving both. Three of the four
      // purposes must work with no credential — a password reset the logged-out
      // user cannot request is not a password reset — and `change_email` needs
      // one. The registry cannot express *sometimes*, and it should not: it
      // would have to read the body to decide, which is the router doing the
      // route's job.
      auth: 'anonymous',
      async handle({ caller, body }) {
        if (body.purpose === 'change_email') {
          // The link goes to the **new** address, to prove the caller controls
          // it. `must` raises the same 401 the registry would have.
          const authenticated = must(caller);
          await requestChallenge(
            app.deps,
            subjectOf(authenticated),
            {
              email: body.newEmail ?? '',
              purpose: Purpose.ChangeEmail,
              payload: body.newEmail ?? '',
            },
            provenance(),
          );
          return text(202, '');
        }

        await requestChallenge(
          app.deps,
          anonymousSubject(),
          { email: body.email, purpose: PURPOSES[body.purpose] },
          provenance(),
        );
        // The command returns `void`; there is nothing here that *could* differ.
        return text(202, '');
      },
    }),

    route({
      method: 'POST',
      path: '/v1/links/consume',
      summary: 'Consume an emailed secret',
      body: ConsumeBody,
      // **One route for all four purposes** — `CONFORMANCE.md` §3.5. The
      // purpose is read from the challenge, never from the request: the token
      // already identifies both the user and the purpose, so a per-purpose path
      // restated what the server has to look up anyway and gave the two
      // somewhere to disagree.
      //
      // **The token is in the body and never in the URL.** URLs reach access
      // logs, referrer headers and browser history, and a single-use secret
      // that leaks into any of the three is spent before its owner clicks it.
      //
      // 201 when the link was a magic link, 204 otherwise — the caller learns
      // which from the status rather than from the path it chose.
      replies: { 201: TokenReply, 204: z.null(), 400: Problem, 429: Problem },
      auth: 'anonymous',
      async handle({ body }) {
        const outcome = await consumeLink(
          app.deps,
          anonymousSubject(),
          {
            token: body.token,
            ...(body.password === undefined ? {} : { password: body.password }),
          },
          provenance(),
        );

        const { session, token } = outcome;
        if (session === undefined || token === undefined) {
          return text(204, '');
        }
        return json(201, {
          access_token: token,
          token_type: 'Bearer',
          expires_at: session.expiresAt.toISOString(),
          user_id: session.userId,
          session_id: session.id,
        });
      },
    }),

    route({
      method: 'POST',
      path: '/v1/users/:id/roles',
      summary: 'Grant a role',
      body: GrantRoleBody,
      // **`POST` to the collection, role in the body** — §3.5. It was
      // `PUT /v1/users/{id}/roles/{role}`, which reads as *make this true* and
      // is defensible; the table settles it the other way, and a surface no
      // sibling shares is worth less than the argument for either spelling.
      replies: {
        200: RolesReply,
        400: Problem,
        401: Problem,
        403: Problem,
        404: Problem,
        409: Problem,
        422: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller, params, body }) {
        const result = await grantRole(
          app.deps,
          subjectOf(must(caller)),
          userId(params['id'] ?? ''),
          role(body.role),
          provenance(),
        );
        return json(200, { roles: result.roles, version: result.version });
      },
    }),

    route({
      method: 'DELETE',
      path: '/v1/users/:id/roles/:role',
      summary: 'Revoke a role',
      replies: {
        200: RolesReply,
        401: Problem,
        403: Problem,
        404: Problem,
        409: Problem,
        422: Problem,
        429: Problem,
      },
      auth: 'required',
      async handle({ caller, params }) {
        const result = await revokeRole(
          app.deps,
          subjectOf(must(caller)),
          userId(params['id'] ?? ''),
          role(params['role'] ?? ''),
          provenance(),
        );
        return json(200, { roles: result.roles, version: result.version });
      },
    }),

    route({
      method: 'POST',
      path: '/v1/me/password',
      summary: 'Change the caller`s password',
      body: ChangePasswordBody,
      replies: {
        200: z.object({ revokedSessions: z.number() }),
        401: Problem,
        400: Problem,
        403: Problem,
        409: Problem,
        412: Problem,
        422: Problem,
        429: Problem,
      },
      auth: 'required',
      validated: true,
      async handle({ caller, body }) {
        const { user, session } = mustSession(caller);
        const input = body;

        // Case 9: revokes every **other** session and leaves this one live.
        const result = await changePassword(
          app.deps,
          subjectOf(mustSession(caller)),
          {
            userId: user.id,
            current: input.current_password,
            next: input.new_password,
            currentSession: session.id,
          },
          provenance(),
        );

        return json(200, { revokedSessions: result.revokedSessions });
      },
    }),
  ];
}

/**
 * The `Subject` for an unauthenticated caller.
 *
 * **`M4` requires one on every use case, and a public route still has one.**
 * Anonymous is a subject, not the absence of one — which is what keeps
 * `denyAll` meaningful and what a future *administrator registers a user* flow
 * will slot into without changing a signature.
 */
/**
 * Refuse a mutating request that carries no precondition. **428.**
 *
 * `PATCH` without one is a lost update waiting for two administrators to be
 * looking at the same person. §3.5 makes `If-Match` required on this route, and
 * *required* is the route's rule rather than `conditional`'s: position 9
 * evaluates a precondition that is **present** and has nothing to say about one
 * that is absent, because on most routes absent is correct.
 *
 * **It reads nothing out of the tag**, and the first version of this did — it
 * parsed a version out of `If-Match` to pass to the command, which is the §3
 * mistake wearing a new hat: an ETag identifies a representation and
 * deliberately does not encode an entity version. Freshness is `conditional`'s
 * 412, and the write's own `(id, baseVersion)` check is the backstop. This
 * asserts only that the caller made a claim at all.
 */
function requirePrecondition(headers: Readonly<Record<string, string>>): void {
  const supplied = headers['if-match'];
  if (supplied === undefined || supplied.trim() === '') {
    throw new AppError(
      Kind.PreconditionRequired,
      'this request requires an If-Match header naming the version you read',
      // Not `precondition_failed`: 412 means *your validator is stale*, which
      // is a different and more hopeful thing to tell a caller than *you sent
      // none*.
      //
      // **And not `Invalid` either, which is what this was.** The slug has said
      // `precondition-required` since it was written, next to a 400 — RFC 6585
      // gives that condition its own status and the `Kind` vocabulary had no
      // value for it, so the note here used to claim the status *could not*
      // carry the distinction. It can. ADR 0013.
      { problem: 'precondition-required' },
    );
  }
}

function anonymousSubject(): Subject {
  return subject({
    actor: Actor.anonymous(),
    roles: [],
    tenant: 'default',
  });
}

/**
 * The ambient provenance, read at the boundary.
 *
 * `PROVENANCE.md`'s carriage rule: *read ambient at a boundary, pass explicit
 * across one.* This is the boundary — position 1 of the chain put it there —
 * and every command below takes it as an argument.
 */
function provenance(): Provenance {
  const current = Carrier.current();
  if (current === undefined) {
    // A wiring error, and one that would otherwise surface as an event with no
    // correlation id — invisible until somebody tried to trace a request.
    throw internal('identity routes must be mounted behind the httpx chain');
  }
  return current;
}
