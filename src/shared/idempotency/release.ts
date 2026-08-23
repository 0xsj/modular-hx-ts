/**
 * Whether a failure gives the key back. **L4 edge.**
 *
 * **This started as "5xx releases, 4xx holds" and that rule was wrong**, in a
 * way worth recording rather than quietly fixing: the status class was never
 * the real test, it was a proxy for one, and it agreed with the real test on
 * every case anybody had written down until `conditional` landed.
 *
 * The real test is two questions:
 *
 * | | would re-execution answer the same? | did anything happen? | |
 * | --- | --- | --- | --- |
 * | server fault | **might differ** | **might have** | release |
 * | precondition failed | **will differ** | **definitely not** | release |
 * | invalid, unprocessable, not found, conflict | same every time | no | hold |
 * | canceled | might differ | **might have** | hold |
 *
 * A 4xx *usually* answers the same way every time, which is why the old rule
 * held up. **A 412 does not.** It depends on server state, and a client that
 * re-reads and sends a corrected validator *should* get a different answer —
 * so holding the key strands a client that fixed its request properly. It has
 * to invent a new key to make progress on a request it already corrected, which
 * is the opposite of what a key is for.
 *
 * Releasing on a 412 is safe for a reason **specific to 412**, not a loosening
 * of the rule: the precondition is evaluated *before the handler runs*, so
 * nothing executed and there is no write to double-apply. `conditional` sits
 * inside this module at position 9 and throws before calling `next`, which is
 * what makes that structural rather than a promise.
 *
 * **A handler that throws `preconditionFailed` inherits the obligation.** The
 * kind means *the state you asserted is not the state that is here*, which
 * asserts the write did not apply. Throwing it after a partial write would be a
 * lie, and this module would believe it.
 *
 * `Canceled` stays held, and it is the row that shows why "did anything happen"
 * is a separate question from "would the answer differ": a caller who hung up
 * tells us nothing about whether the handler finished.
 *
 * See `notes/patterns/idempotency.md`.
 */

import { Kind, isServerFault, kindOf } from '../errors/index.js';

export function releasesKey(error: unknown): boolean {
  // Might differ on a retry, and might have happened. Storing it would freeze a
  // transient failure for the whole TTL.
  if (isServerFault(error)) return true;

  // Will differ once the client re-reads, and definitely did not happen.
  if (kindOf(error) === Kind.PreconditionFailed) return true;

  // Everything else answers the same way every time, and releasing invites a
  // client to retry its way to a different outcome.
  return false;
}
