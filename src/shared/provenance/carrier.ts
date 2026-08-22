/**
 * The ambient carrier. **L1 runtime.**
 *
 * `../../../PROVENANCE.md` §3, in one line:
 *
 * > **Read ambient at a boundary. Pass explicit across one.**
 *
 * Transport middleware puts provenance in with `run`. Three consumers read it
 * out — `logger`, `httpclient` and `telemetry` — because threading it through
 * every log call would be noise, and because those three cannot forget. The
 * application layer reads it **once** at the top of a use case and passes it
 * explicitly onward.
 *
 * **Why this is not the ambient-state rule `authz` follows.** A `Subject` is a
 * decision input: read ambiently, a forgotten authorization check looks exactly
 * like a passed one, which is silent and a security failure. Nothing branches
 * on provenance. A missing correlation id degrades observability and grants
 * nothing, so the failure modes differ in kind and the rules differ with them.
 *
 * Anything producing an artifact that outlives the request — an event envelope,
 * an audit row, an attestation — takes provenance **explicitly**. That is what
 * makes rule `M5` enforceable: *"publish goes through a constructor that
 * requires provenance"* is checkable; *"hopefully the context had it"* is not.
 *
 * See `notes/patterns/provenance.md`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { internal } from '../errors/index.js';
import { type Provenance } from './provenance.js';

const storage = new AsyncLocalStorage<Provenance>();

export const Carrier = {
  /**
   * Run something with provenance in scope.
   *
   * The scope follows the async chain — `await`, `then`, timers, streams — so a
   * handler does not have to thread it anywhere. Returns whatever the callback
   * returns, and propagates whatever it throws.
   */
  run<T>(provenance: Provenance, fn: () => T): T {
    return storage.run(provenance, fn);
  },

  /**
   * Provenance, if there is any.
   *
   * **Never throws.** `logger` is the caller that matters here, and a log line
   * must never crash — least of all the one being written while something else
   * is already going wrong.
   */
  current(): Provenance | undefined {
    return storage.getStore();
  },

  /**
   * Provenance, or a bug.
   *
   * For stamp points — an envelope, an audit row, an attestation. Raises
   * `Internal` rather than `Invalid`: a missing field where a record is being
   * written is a programmer error, not user input.
   *
   * Prefer taking provenance as a parameter. This exists for the boundary that
   * genuinely has no parameter to take it from.
   */
  require(): Provenance {
    const provenance = storage.getStore();
    if (provenance === undefined) {
      throw internal('no provenance in scope');
    }
    return provenance;
  },
} as const;
