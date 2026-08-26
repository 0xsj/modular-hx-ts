/**
 * Re-export of the promoted mechanics. **`identity` app.**
 *
 * The body of this file is now `shared/token` — promoted when `orgs` needed the
 * identical thing for an invitation, because `S6` makes a context's code
 * unreachable from the next one and the second copy is the trigger.
 *
 * It stays as a re-export rather than being deleted, so this context's call
 * sites keep naming the thing they use rather than reaching across the tree at
 * fifteen import sites. The one that matters is `S2`: a shared module is
 * entered through its root, and this is a local alias for one, not a second
 * implementation.
 */

export {
  type Secret,
  bind,
  fingerprintOf,
  mintSecret,
  secretMatches,
} from '../../../shared/token/index.js';
