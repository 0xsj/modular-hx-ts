/**
 * How a handler supplies its current validator. **L4 edge, and deliberately
 * unimplemented.**
 *
 * **This file is the half of `conditional` that waits.** RFC 9110 fixes the
 * grammar, the comparisons and the evaluation order, so all of that ships now
 * and none of it is a guess. What it cannot fix is where an ETag comes from,
 * because that depends on aggregates this repository has not written.
 *
 * So the interface lands and no implementation does — the same shape `httpx`
 * used when it left position 5's budget reachable before `deadline` existed.
 * **An interface with no implementer is the point**, not an omission: it is
 * what makes the first aggregate's obligation visible at the moment it is
 * written rather than discovered afterwards.
 *
 * Inventing an implementation now would be worse than leaving it empty. It
 * would have to guess at versioning, at which fields are part of the
 * representation, and at how a collection endpoint tags itself — three
 * decisions the domain makes, encoded before the domain exists, and then
 * inherited by everything that follows.
 *
 * See `notes/patterns/conditional.md`.
 */

import { type Exchange } from '../edge/index.js';
import { type Validator } from './preconditions.js';

/**
 * The current validator for the representation this request addresses, or
 * `undefined` when there is none.
 *
 * **The whole `Exchange`, not just an id**, and that is the part worth getting
 * right now: a tag identifies a **representation**, not an entity. The same
 * resource served as JSON and as CSV must not share one, so the implementer
 * needs the request — `Accept`, `Accept-Language`, the path — to know which
 * representation it is being asked about. An interface that took only a
 * resource identifier would make the variant unrepresentable, and the mistake
 * would be locked in by the signature.
 *
 * `undefined` means *no current representation*, which is what gives
 * `If-Match: *` its create-only meaning and `If-None-Match: *` its
 * replace-only one.
 *
 * Two things it deliberately does not decide, because the first aggregate will:
 *
 * - **whether collection endpoints carry tags at all.** A list whose ETag
 *   changes on any member's change is correct and nearly useless; one that
 *   ignores members is useless differently.
 * - **whether the tag is computed or stored.** `strongTagFor` computes one from
 *   a canonical serialization, which needs no column; a stored version column
 *   is cheaper to read and has to be maintained. Both satisfy this interface.
 */
export type Validators = (
  exchange: Exchange,
) => Promise<Validator | undefined> | Validator | undefined;
