/**
 * Provenance: who caused this, and what caused that. **L1 runtime.**
 *
 * The module's only importable surface — rule `S2` makes reaching past this
 * file a violation, which is how TypeScript gets the boundary Go gets from an
 * unexported identifier.
 *
 * **Deliberately not exported:**
 *
 * - `createProvenance` — the raw constructor. Application code reaches
 *   provenance through an origin, every one of which mints or derives, so a
 *   hand-built child cannot end up carrying its parent's request id and
 *   collapsing the causal graph into a self-loop.
 * - `isProvenanceId` and `isTraceparent` — adoption happens at the boundary in
 *   `origins`, and nowhere else needs to know the shapes.
 * - `provenance.testkit` — test tooling, and rule `S3` keeps it out of
 *   shipping code.
 *
 * Specification: `../../../PROVENANCE.md`. Note: `notes/patterns/provenance.md`.
 */

export { Actor, ActorKind, type ActorWire } from './actor.js';
export { Provenance, type ProvenanceWire } from './provenance.js';
export { makeOrigins, type InboundHeaders, type Origins } from './origins.js';
export { Carrier } from './carrier.js';
