/**
 * API keys. **`identity` app · command.** Conformance cases 16 and 17.
 *
 * **Case 17 is a subtraction, and this file does almost nothing to enforce it.**
 * A key's effective permissions are the *intersection* of its scopes and its
 * owner's grants — a scope can only narrow, never grant — and `authz` already
 * computes that from `Subject.scopes`. What this context does is carry the
 * scopes and make sure the `Subject` a request is judged against is built from
 * the **owner's** roles with the **key's** scopes attached. Re-implementing the
 * intersection here would be a second place for it to be wrong.
 *
 * See `notes/domain/identity.md`.
 */

import { type Clock } from '../../../../shared/clock/index.js';
import { type IdGenerator } from '../../../../shared/id/index.js';
import {
  forbidden,
  invalid,
  notFound,
} from '../../../../shared/errors/index.js';
import { type Provenance } from '../../../../shared/provenance/index.js';
import { type Random } from '../../../../shared/random/index.js';
import { type Subject, isAction } from '../../../../shared/authz/index.js';
import {
  type ApiKey,
  type ApiKeyId,
  type UserId,
  API_KEY_PREFIX,
  ApiKey as ApiKeyAggregate,
  IdentityEvent,
  apiKeyId,
} from '../../domain/index.js';
import { type ApiKeys, type Transactor } from '../ports.js';
import { fingerprintOf } from '../tokens.js';

export interface ApiKeyDeps {
  readonly transactor: Transactor;
  readonly apiKeys: ApiKeys;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly random: Random;
}

export interface CreateKeyInput {
  readonly owner: UserId;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: Date;
}

export interface CreatedKey {
  readonly key: ApiKey;
  /**
   * **Shown once. Never stored, never returned again** — case 16.
   *
   * Returned from this function and from the route that calls it, and after
   * that it does not exist anywhere: the aggregate holds a fingerprint, so
   * there is nothing to return even to somebody who asks nicely.
   */
  readonly secret: string;
}

export async function createApiKey(
  deps: ApiKeyDeps,
  subject: Subject,
  input: CreateKeyInput,
  provenance: Provenance,
): Promise<CreatedKey> {
  // `M4`. Minting a key is an act by a person on their own account, and the
  // subject is who they are — which is what a future *admin mints a key for a
  // service account* flow will read.
  void subject;
  for (const scope of input.scopes) {
    if (!isAction(scope)) {
      throw invalid(`not an action: ${scope}`, [
        { field: 'scopes', message: `not an action: ${scope}` },
      ]);
    }
  }

  // Prefixed, so a leaked key is findable by a secret scanner and so the bearer
  // scheme can tell a key from a session token without a second header.
  const secret = `${API_KEY_PREFIX}${deps.random.token()}`;

  const key = ApiKeyAggregate.issue(
    apiKeyId(deps.ids.uuid()),
    input.owner,
    input.name,
    fingerprintOf(secret),
    input.scopes,
    deps.clock.now(),
    input.expiresAt,
  );

  return deps.transactor.within(async (work) => {
    await work.apiKeys.create(key);
    await work.publish(
      {
        name: IdentityEvent.ApiKeyCreated,
        payload: {
          subject: input.owner,
          keyId: key.id,
          name: key.name,
          // The scopes are on the event because `audit` cannot look them up,
          // and *what a key was allowed to do* is the question asked after an
          // incident.
          scopes: [...key.scopes],
        },
      },
      provenance,
    );

    return { key, secret };
  });
}

export async function revokeApiKey(
  deps: ApiKeyDeps,
  subject: Subject,
  owner: UserId,
  id: ApiKeyId,
  provenance: Provenance,
): Promise<void> {
  void subject;
  const key = await deps.apiKeys.byId(id);
  if (key === undefined) throw notFound('no such api key');

  // A key belongs to a person, and only that person retires it. `NotFound`
  // rather than `Forbidden` would be the tenant rule; here the caller is
  // authenticated and the key is theirs or it is not.
  if (key.userId !== owner)
    throw forbidden('that key belongs to somebody else');

  await deps.transactor.within(async (work) => {
    const { changed } = key.revoke(deps.clock.now());
    if (!changed) return;

    await work.apiKeys.save(key);
    await work.publish(
      {
        name: IdentityEvent.ApiKeyRevoked,
        payload: { subject: owner, keyId: key.id },
      },
      provenance,
    );
  });
}

export function listApiKeys(
  deps: ApiKeyDeps,
  subject: Subject,
  owner: UserId,
): Promise<readonly ApiKey[]> {
  void subject;
  return deps.apiKeys.listFor(owner);
}
