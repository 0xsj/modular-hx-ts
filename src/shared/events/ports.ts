/**
 * The ports. **L2 substrate.**
 *
 * `events` is a **port with swappable providers**, and the outbox is one
 * provider rather than the module (`../../../MODULES.md` §3).
 * `EVENTS_PROVIDER=memory|outbox`, exactly as `STORAGE=memory|postgres`.
 *
 * See `notes/patterns/events.md`.
 */

import { type DB } from '../postgres/index.js';
import { type Provenance } from '../provenance/index.js';
import { type Envelope } from './envelope.js';
import { type Event } from './event.js';

/**
 * Publishing.
 *
 * **`db` is the caller's transaction, and it is not optional for the outbox.**
 * That parameter is the entire reason the outbox exists: the event row is
 * written inside the *caller's* transaction, so publishing is atomic with the
 * data write. A publisher that opened its own connection would be back to two
 * transactions and the dual-write problem it was built to remove.
 *
 * The memory bus ignores it, which is honest rather than sloppy — it has
 * nothing to make atomic.
 */
export interface Publisher {
  publish(event: Event, provenance: Provenance, db?: DB): Promise<Envelope>;
}

/**
 * What a subscriber is.
 *
 * Handling is `Promise<void>`: throwing means *not handled*, and the provider
 * decides what that costs. It never costs the publisher its write.
 */
/**
 * `void` as well as `Promise<void>`: a subscriber doing synchronous work —
 * appending to a projection, incrementing a counter — should not have to wear
 * `async` to satisfy the port. Providers await the result either way.
 */
export type Handler = (envelope: Envelope) => Promise<void> | void;

export interface Subscription {
  /** The event name, or a `<context>.*` prefix. */
  readonly pattern: string;
  /**
   * Names this subscriber in dedupe records and dead letters.
   *
   * Required, and stable: at-least-once delivery means a subscriber is
   * identified by something that survives a restart, and an anonymous handler
   * cannot dedupe.
   */
  readonly name: string;
  readonly handle: Handler;
}

export interface Subscriber {
  subscribe(subscription: Subscription): void;
}

/**
 * What moves events from wherever they are to whoever wants them.
 *
 * In-process for the memory bus, and a leased relay for the outbox. Separate
 * from `Publisher` because the composition root starts and stops it — it is a
 * `lifecycle` component, and publishing is not.
 */
export interface Dispatcher {
  /** Deliver whatever is pending. Returns how many envelopes were dispatched. */
  drain(): Promise<number>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface Events extends Publisher, Subscriber {
  readonly dispatcher: Dispatcher;
}

/** Whether a subscription pattern selects an event name. */
export function matches(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.endsWith('.*')) return false;
  return name.startsWith(pattern.slice(0, -1));
}
