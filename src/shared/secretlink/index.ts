/**
 * An out-of-band link: **id, secret and tag, on the wire.** L3 capability.
 *
 * `token` is the primitive underneath — mint a bearer secret, keep only its
 * digest, compare by digesting. Sessions and API keys need exactly that and
 * nothing more. **This is the layer above it**, and it exists for the values
 * that leave the system and come back: password resets, magic links,
 * invitations.
 *
 * **Two modules rather than one, and the split is not cosmetic.** A session
 * token has no MAC, no identifier on the wire and no out-of-band journey; one
 * module doing both would make every session carry link machinery it never
 * uses, and would hide which half a caller depends on. `token` is pure and sits
 * at L0; this needs `crypto`, so it cannot.
 *
 * **What deliberately is not here: TTL, single-use and purpose.** Those are
 * rules, and rules belong to an aggregate — `S7` puts no shared module within
 * reach of a `domain/`, so they could not travel even if they should. The
 * signal named in the collection brief is exact: *if you find yourself wanting
 * a clock inside either module, you are moving the wrong half.* There is no
 * clock in this file.
 *
 * See `notes/patterns/secretlink.md`.
 */

import { type Mac } from '../crypto/index.js';
import { type Result, err, isErr, ok } from '../result/index.js';
import { type Random, constantTimeEqual } from '../random/index.js';
import { bind, fingerprintOf, mintSecret } from '../token/index.js';

/**
 * The separator between the three parts.
 *
 * A dot, because the wire value travels in a URL, an email body and a form
 * field, and the parts must survive all three untouched. A UUID and a base64url
 * secret contain no dot, so the front of the split is unambiguous — the **tag**
 * does contain dots, and `parse` gives it everything after the second one.
 */
const SEPARATOR = '.';

export interface IssuedLink {
  /** The identifier a store looks the row up by. */
  readonly id: string;
  /**
   * The whole thing, delivered once and never stored.
   *
   * `<id>.<secret>.<tag>` — the caller emails this and keeps nothing.
   */
  readonly token: string;
  /**
   * `sha256:` of the secret. **This is what a repository holds.**
   *
   * The store never holds a usable value, which is what makes conformance case
   * 16 true rather than aspirational: a key shown once must be one that
   * *cannot* be returned, and a fingerprint cannot be presented.
   */
  readonly fingerprint: string;
}

export interface IssueOptions {
  /** The row's identifier. Minted by the caller, because ids are theirs. */
  readonly id: string;
  readonly random: Random;
  readonly mac: Mac;
}

/**
 * Mint a link.
 *
 * The tag binds **the id and nothing else**, deliberately. It is checked before
 * any lookup, so it must be verifiable from the wire value alone — binding a
 * subject or a purpose would make that impossible, since neither is known until
 * the row is read.
 *
 * A caller that also wants *this row was not tampered with* keeps a second tag
 * over its own fields, in its own aggregate. That one binds domain values, so
 * it belongs to the domain — see the note.
 */
export function issue(options: IssueOptions): Result<IssuedLink> {
  const secret = mintSecret(options.random);
  const tag = options.mac.tag(bind(options.id));
  if (isErr(tag)) return err(tag.error);

  return ok({
    id: options.id,
    token: [options.id, secret.raw, tag.value].join(SEPARATOR),
    fingerprint: secret.fingerprint,
  });
}

export interface PresentedLink {
  readonly id: string;
  readonly secret: string;
  readonly tag: string;
}

/**
 * Split a presented value into its three parts.
 *
 * `undefined` for anything that is not the shape — never a distinct error,
 * because a caller must not be able to tell a malformed link from an expired
 * one. That is the same rule conformance case 13 fixes for challenges, and it
 * is enforced here by having nothing else to return.
 */
export function parse(token: string): PresentedLink | undefined {
  const parts = token.split(SEPARATOR);
  // **At least three, and the tag keeps the rest.** `crypto` spells a tag
  // `v1.<kid>.<tag>`, which contains two dots of its own — so an exact
  // three-part split refused every link this module issued, on the first test
  // that read one back. The id and the secret are dot-free by construction, so
  // taking two from the front and rejoining the remainder is unambiguous.
  if (parts.length < 3) return undefined;

  const id = parts[0];
  const secret = parts[1];
  const tag = parts.slice(2).join(SEPARATOR);
  if (id === undefined || secret === undefined) return undefined;
  if (id === '' || secret === '' || tag === '') return undefined;

  return { id, secret, tag };
}

/**
 * Is this tag one we issued for this id? **Checked before any lookup.**
 *
 * **The MAC is not decoration.** Without it, an identifier on the wire is an
 * identifier an attacker can forge and probe against the table — one request
 * per guess, and the answer is whether the row exists. With it, a forged id is
 * refused by arithmetic, before the database is touched at all.
 *
 * Constant-time through `Mac.verify`, which compares the tag rather than the
 * string.
 */
export function authentic(link: PresentedLink, mac: Mac): boolean {
  return mac.verify(bind(link.id), link.tag);
}

/**
 * Does the presented secret match the stored fingerprint?
 *
 * Constant-time, for a narrower reason than it looks: the row was found by id,
 * so the database has already leaked whether it exists. This closes the
 * remaining comparison and costs nothing.
 */
export function matches(link: PresentedLink, fingerprint: string): boolean {
  return constantTimeEqual(fingerprintOf(link.secret), fingerprint);
}

/**
 * Parse and authenticate in one step, for the common call site.
 *
 * Returns the parts when the value is well-formed **and** carries a tag we
 * issued. Everything else is one refusal, which is what keeps a caller from
 * accidentally telling the two apart.
 */
export function readable(token: string, mac: Mac): PresentedLink | undefined {
  const link = parse(token);
  if (link === undefined) return undefined;
  return authentic(link, mac) ? link : undefined;
}

/**
 * **There is deliberately no refusal exported from here.**
 *
 * The first version had one, and a context that used it for *malformed* while
 * keeping its own for *expired* said two different things — which is exactly
 * the enumeration oracle conformance case 13 forbids, introduced by the
 * extraction itself and caught by the test asserting the two are identical.
 *
 * A refusal message belongs to the surface that answers, not to the mechanism.
 * Every function here returns `undefined` instead, so a caller has nothing to
 * spell differently.
 */
