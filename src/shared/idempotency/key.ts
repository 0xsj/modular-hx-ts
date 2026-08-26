/**
 * The scoped key, and the request fingerprint. **L4 edge.**
 *
 * **A key is scoped, never global** — `../../../MODULES.md` §5. The lookup key
 * is the client's `Idempotency-Key` *plus the tenant and the authenticated
 * principal*. A bare key is a cross-tenant read: a caller who guesses another
 * tenant's key replays that tenant's response body, and neither party can tell
 * it happened.
 *
 * This is the reason position 9 sits below authn and tenant rather than above
 * them. It cannot build its own key until those have run, so the order is not a
 * preference — it is a precondition.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { type Digest, digest } from '../digest/index.js';
import { internal, invalid } from '../errors/index.js';
import { ActorKind, type Provenance } from '../provenance/index.js';
import { err, ok, type Result } from '../result/index.js';

/** The client's header. */
export const KEY_HEADER = 'idempotency-key';

/**
 * Marks a response as replayed rather than freshly computed.
 *
 * A client that cannot tell the difference cannot tell a successful retry from
 * a second execution, which is the whole thing it asked to be protected from.
 */
/**
 * **`idempotency-replayed`, and it was `idempotency-replayed`.**
 *
 * The adjective, not the noun — a spelling nobody would notice until something
 * read it. `CONFORMANCE.md`'s case 25 asserts `Idempotency-Replayed`, and the
 * conformance runner reported it absent while it was being emitted under a name
 * one letter-group away. Header names are case-insensitive and **not**
 * spelling-insensitive.
 */
export const REPLAY_HEADER = 'idempotency-replayed';

/**
 * A key, and everything that scopes it.
 *
 * Three fields rather than one pre-joined string, because an operator reading
 * the table needs to see *whose* key it is — and because joining is a decision
 * that must be made once, below, rather than at every call site.
 */
export interface ScopedKey {
  /** `''` in single-tenant mode, which keeps that mode byte-identical. */
  readonly tenant: string;
  /** `Actor.toString()` — `user:01a0...`. Never `anonymous:`; see below. */
  readonly principal: string;
  /** Verbatim from the client. Opaque to us. */
  readonly key: string;
}

/**
 * ASCII **unit separator**, U+001F — the same separator and the same reason as
 * `flags/cohort.ts`: it cannot occur in a tenant id, an actor string or a
 * client key, so the join is unambiguous **by construction** and needs no
 * rejection rule.
 *
 * Written as an escape rather than a literal byte, because a raw control
 * character makes the file binary to every text tool. This repository has paid
 * for that three times.
 */
const SEPARATOR = '\u001f';

/** The single string form. A map key, and nothing a human reads. */
export function identityOf(scoped: ScopedKey): string {
  return `${scoped.tenant}${SEPARATOR}${scoped.principal}${SEPARATOR}${scoped.key}`;
}

/**
 * Build the scoped key, or refuse.
 *
 * **An anonymous caller is a wiring error, not a client error.** Reaching here
 * without a principal means the route permits anonymous callers — a route that
 * required authentication was already refused at position 6 — and this
 * middleware must not be mounted on such a route at all. The pairing is refused
 * at startup by `idempotency()`; this is the runtime backstop, and the `Kind`
 * is `Internal` because a misconfigured route is our mistake and not the
 * caller's.
 *
 * Answering 401 here would be worse than useless: it asserts that the endpoint
 * requires authentication, which it demonstrably does not, while breaking a
 * client that did nothing worse than send a key. See ADR 0009.
 */
export function scopedKey(
  provenance: Provenance,
  key: string,
): Result<ScopedKey> {
  if (key.length === 0 || key.length > 255) {
    // A genuine client error: the header is present and unusable. `Invalid`
    // rather than `Unprocessable` because this one did not parse.
    return err(invalid('an Idempotency-Key is 1-255 characters'));
  }
  if (provenance.actor.kind === ActorKind.Anonymous) {
    return err(
      internal(
        'idempotency is mounted on a route that permits anonymous callers; ' +
          'two anonymous callers presenting the same key would replay each ' +
          "other's responses, and there is no safe discriminator",
      ),
    );
  }

  return ok({
    tenant: provenance.tenant ?? '',
    principal: provenance.actor.toString(),
    key,
  });
}

/**
 * A digest of the **canonical** request, not of the raw bytes.
 *
 * Raw bytes would make a re-serialized but semantically identical payload look
 * like a different request, turning a safe client retry into case 26's 422 —
 * the exact failure the mechanism exists to prevent. `digest` canonicalizes
 * under RFC 8785, which is the canonicalization the collection already pins and
 * the one the envelope digests already use.
 *
 * A body that is not JSON is fingerprinted as the string it is: a form post or
 * an opaque payload still has a stable identity, and refusing to fingerprint it
 * would mean refusing keys on endpoints with every right to accept them.
 */
export function fingerprint(
  method: string,
  path: string,
  body: string,
): Result<Digest> {
  let payload: unknown = body;
  try {
    payload = body === '' ? null : (JSON.parse(body) as unknown);
  } catch {
    // Not JSON. The raw string is its own canonical form.
  }

  return digest({ method: method.toUpperCase(), path, body: payload });
}
