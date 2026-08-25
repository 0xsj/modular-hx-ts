/**
 * Position 9. **L4 edge.**
 *
 * Claim before running, replay stored responses, fail closed. It fills the slot
 * `httpx` left named and empty, and the wiring is one line — which is the whole
 * point of having left it named.
 *
 * It imports the chain vocabulary from the **floor** rather than from `httpx`:
 * `httpx` assembles the chain, this module is a position in it, and both need
 * the types. `../../../ARCHITECTURE.md` §L4.
 *
 * **Three rules in here will look like mistakes to a future reader, and all
 * three are deliberate.** They are documented at the point they are implemented
 * rather than only in the note, because that is where somebody is standing when
 * they decide to simplify one. The release rule has its own file, `release.ts`,
 * because it needed a table rather than a paragraph.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { invariant } from '../assert/index.js';
import { conflict, unavailable, unprocessable } from '../errors/index.js';
import {
  type Exchange,
  type Middleware,
  type Reporter,
  type Response,
} from '../edge/index.js';
import { capExceeded, exceedsCap, storableHeaders } from './capture.js';
import { releasesKey } from './release.js';
import {
  KEY_HEADER,
  REPLAY_HEADER,
  fingerprint,
  scopedKey,
  type ScopedKey,
} from './key.js';
import { type Records } from './port.js';

export interface IdempotencyOptions {
  readonly records: Records;

  /**
   * How the routes behind this middleware treat an unauthenticated caller.
   *
   * **`'permitted'` is refused at construction**, which for a composition root
   * means at startup. The key is scoped by tenant *and principal*, so on a
   * public route two anonymous callers presenting the same key string would
   * replay each other's responses — and there is no safe discriminator to fall
   * back to. A peer address is one NAT from useless and makes the scope depend
   * on network topology rather than identity.
   *
   * Refused **where the pairing is declared** rather than per request. A route
   * that required authentication was already refused at position 6, so an
   * anonymous caller reaching position 9 means the route is public, and no
   * status this module could return would be true of it. See ADR 0009.
   */
  readonly anonymousCallers: 'refused' | 'permitted';

  /**
   * Paths this middleware does not engage on.
   *
   * **The seam the composition root exposed.** `anonymousCallers: 'refused'`
   * asserts that everything behind this position requires authentication, and
   * that is false for any real process: one chain serves a login endpoint and a
   * charge endpoint, and routing happens *below* position 9 so it cannot ask a
   * route which it is.
   *
   * Without this, a client retrying **registration** with an `Idempotency-Key`
   * — a perfectly reasonable thing to do — gets a 500, because the anonymous
   * backstop fires on a route that is legitimately public.
   *
   * Listing them in the root is the honest short answer rather than the tidy
   * one: the root is what knows both the chain and the routes. The tidy answer
   * is for idempotency to be **declared per route**, the way `auth` is, which
   * needs the registry to run it — and that inverts the chain order `httpx`
   * specifies. Raised rather than resolved locally; see the note.
   */
  readonly exempt?: readonly string[];

  /**
   * Where a fail-closed refusal is announced.
   *
   * Invariant `I9` requires the choice to be *logged when it fires*, not merely
   * made: a 503 nobody can attribute to the idempotency store looks like the
   * database being down, and the operator goes and looks at the wrong thing.
   */
  readonly reporter?: Reporter;
}

/**
 * Methods with no state to protect.
 *
 * A key on one of these is meaningless rather than wrong, so it is ignored
 * rather than refused — a client library that attaches the header to every
 * request is being harmlessly thorough, and turning that into a 4xx would
 * punish it for nothing.
 */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

export function idempotency(options: IdempotencyOptions): Middleware {
  const { records, reporter } = options;

  // Startup, not request time. A wiring mistake that fails on the first request
  // of the day fails in front of a customer; this one fails in front of whoever
  // wrote it.
  invariant(
    options.anonymousCallers === 'refused',
    'idempotency cannot be mounted on a route that permits anonymous callers: ' +
      'the key is scoped by principal, and two anonymous callers presenting ' +
      'the same key would replay each other',
  );

  const report = (message: string, fields: Record<string, unknown>): void => {
    reporter?.error(message, fields);
  };

  /** Never let a store failure during cleanup mask the real outcome. */
  const releaseQuietly = async (key: ScopedKey): Promise<void> => {
    try {
      await records.release(key);
    } catch (error) {
      report('idempotency key could not be released', {
        key: key.key,
        error: String(error),
      });
    }
  };

  const exempt = new Set(options.exempt ?? []);

  return async (exchange: Exchange, next): Promise<Response> => {
    const { request } = exchange;
    const supplied = request.headers[KEY_HEADER];

    if (
      supplied === undefined ||
      SAFE.has(request.method.toUpperCase()) ||
      exempt.has(request.path)
    ) {
      return next(exchange);
    }

    // Built from the provenance, which is why this position sits below authn
    // and tenant. An anonymous caller here throws `Internal` — the runtime
    // backstop for the pairing already refused above.
    const key = scopedKey(exchange.provenance, supplied);
    if (!key.ok) throw key.error;

    const body = await request.body();
    const print = fingerprint(request.method, request.path, body);
    if (!print.ok) throw print.error;

    let claim;
    try {
      claim = await records.claim(key.value, print.value);
    } catch (error) {
      // **Fail closed** — `../../../RESILIENCE.md` §1. Never "proceed without a
      // claim": executing unclaimed double-applies the write the client asked
      // to have protected, which is the failure the header was sent to avoid.
      //
      // This is the exact opposite of `ratelimit`'s default in position 7, and
      // the two are not in tension: a throttle that fails open loses some
      // throttling, and a claim that fails open loses the money.
      report('idempotency store unreachable; failing closed', {
        path: request.path,
        error: String(error),
      });
      throw unavailable('the request could not be accepted right now', {
        cause: error,
      });
    }

    switch (claim.outcome) {
      case 'mismatch':
        // Case 26. **`Unprocessable`, not `Invalid`** — the key and the payload
        // are each perfectly well-formed and it is their disagreement that
        // cannot be acted on, which is the distinction decision 0010 added the
        // `Kind` for. The fingerprint is over the *canonical* request, so this
        // fires on a genuinely different payload and not on a re-serialized
        // identical one.
        throw unprocessable(
          'this Idempotency-Key was used with a different request',
          // The catalogue names this one — `CONFORMANCE.md` §3.5. A client
          // branching on `type` needs to tell it from a still-running claim,
          // because one is worth retrying and the other never will be.
          { problem: 'idempotency-mismatch' },
        );

      case 'in-flight':
        // Case 27. Bounded by the lease, never permanent — see `port.ts`.
        throw conflict('a request with this Idempotency-Key is still running', {
          problem: 'idempotency-in-flight',
        });

      case 'consumed':
        // Spent past the cap. **Definitive, not "come back later"**: the work
        // happened, the answer is gone, and re-running would double-apply it.
        // 409 would promise a reply that is never coming.
        throw unprocessable(
          'this Idempotency-Key was spent by a request whose response was too ' +
            'large to store; it completed and cannot be replayed',
        );

      case 'replay':
        // Case 25. Status and body exactly as stored; the headers were filtered
        // on the way in, so nothing per-request is being replayed. Position 1
        // adds *this* request's id on the way out, which is what makes the
        // replay honest rather than merely identical.
        return {
          status: claim.response.status,
          headers: { ...claim.response.headers, [REPLAY_HEADER]: 'true' },
          body: claim.response.body,
        };

      case 'claimed':
        break;
    }

    let response: Response;
    try {
      response = await next(exchange);
    } catch (error) {
      // **Two questions, not a status class**: would re-execution answer the
      // same way, and did anything happen? `release.ts` carries the whole
      // table, and the reason the obvious rule — *5xx releases, 4xx holds* —
      // is wrong for exactly one case.
      //
      // This is still the line most likely to be "simplified", and it can now
      // be simplified in two directions. Back to *release on any error* lets a
      // client retry its way to a different outcome. Back to *4xx holds*
      // silently strands every client that corrects a failed precondition,
      // which is worse, because it looks like the rule working.
      if (releasesKey(error)) await releaseQuietly(key.value);
      throw error;
    }

    // A handler may *return* a 5xx rather than throwing one. Same reasoning.
    if (response.status >= 500) {
      await releaseQuietly(key.value);
      return response;
    }

    if (exceedsCap(response)) {
      // Loud, because it is a wiring mistake rather than a runtime condition —
      // and the response still goes through, because it is a real answer to a
      // real request and a 500 here would tell the client its write failed
      // when it did not.
      report(capExceeded(response, request.path), {
        path: request.path,
        status: response.status,
      });

      // **Consumed, never released.** Releasing means the next retry
      // re-executes and double-applies the write, which is the one thing this
      // module exists to prevent. Losing replay is a cost; losing the guarantee
      // is a failure.
      try {
        await records.consume(key.value);
      } catch (error) {
        report('idempotency key could not be spent', {
          path: request.path,
          error: String(error),
        });
      }
      return response;
    }

    try {
      await records.complete(key.value, {
        status: response.status,
        headers: storableHeaders(response.headers),
        body: response.body,
      });
    } catch (error) {
      // **Not fail-closed, and the asymmetry with `claim` above is the point.**
      // Failing closed at claim time prevents an execution. Failing here would
      // deny an execution that has already happened and whose writes are
      // already durable — telling the client its request failed when it
      // succeeded is a worse lie than losing the replay. The client's retry
      // meets the claim, which is still held.
      report('idempotent response could not be stored', {
        path: request.path,
        status: response.status,
        error: String(error),
      });
    }

    return response;
  };
}
