/**
 * Typed ids. **`identity` domain.**
 *
 * `../../../../CONTEXTS.md` §7.1: *typed ids everywhere* — `UserId`, not
 * `string`. Four id types that are all strings at runtime and none of which can
 * be passed where another is expected.
 *
 * **Branded here rather than with `brand`.** Rule `S7` permits `domain/` to
 * import exactly one module, `errors`, so the brand is declared locally. It is
 * a compile-time construct with no runtime cost either way, and the duplication
 * is four lines against an architectural boundary worth keeping — a domain that
 * may import one helper may import two.
 *
 * See `notes/domain/identity.md`.
 */

declare const tag: unique symbol;

/** A string that will not substitute for another kind of string. */
type Tagged<K extends string> = string & { readonly [tag]: K };

export type UserId = Tagged<'UserId'>;
export type SessionId = Tagged<'SessionId'>;
export type ChallengeId = Tagged<'ChallengeId'>;
export type ApiKeyId = Tagged<'ApiKeyId'>;

/**
 * **Minted by the app layer, never by the domain** — §2.1, and §7's *time and
 * ids arrive as arguments*. These are the narrowing functions the app uses on
 * an id it has already generated, not generators.
 */
export const userId = (value: string): UserId => value as UserId;
export const sessionId = (value: string): SessionId => value as SessionId;
export const challengeId = (value: string): ChallengeId => value as ChallengeId;
export const apiKeyId = (value: string): ApiKeyId => value as ApiKeyId;
