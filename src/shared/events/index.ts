/**
 * Events. **L2 substrate — a port with swappable providers.**
 *
 * ```
 * events        Event · Envelope · Publisher / Subscriber / Dispatcher
 *   memory      in-process bus, no durability
 *   outbox      rows written in the CALLER'S transaction, plus a lease relay
 *   eventstest  one contract suite; every provider passes it
 * ```
 *
 * `EVENTS_PROVIDER=memory|outbox`, exactly as `STORAGE=memory|postgres`.
 *
 * **The two providers do not make the same promise, and that is not a defect in
 * the port.** The memory bus publishes in-process: if the process dies between
 * the write and the dispatch, the event is gone. The outbox writes the row
 * inside the caller's transaction, so publishing is atomic with the data write
 * — which is why it exists, and which the memory bus structurally cannot
 * provide. `eventstest` asserts what they share and nothing more.
 *
 * The memory bus is **not a testing convenience**: it is what makes invariant
 * `I1` possible, because an outbox needs Postgres and `make dev` needs nothing.
 *
 * Note: `notes/patterns/events.md`.
 */

export {
  type Event,
  type Payload,
  type Primitive,
  contextOf,
  event,
  isEventName,
} from './event.js';

export { type EnvelopeWire, Envelope, provenanceFor } from './envelope.js';

export {
  type Dispatcher,
  type Events,
  type Handler,
  type Publisher,
  type Subscriber,
  type Subscription,
  matches,
} from './ports.js';

export {
  type MemoryEvents,
  type MemoryOptions,
  memoryEvents,
} from './memory.js';

export {
  type Outbox,
  type OutboxOptions,
  outboxEvents,
  outboxMigrations,
  OUTBOX_TABLE,
} from './outbox/index.js';
