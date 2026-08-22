/**
 * The in-process bus. **A provider, and the one invariant `I1` depends on.**
 *
 * **Not a testing convenience.** `../../../ARCHITECTURE.md` invariant I1
 * requires the whole application to run with **zero external dependencies**,
 * and an outbox needs Postgres. `STORAGE=memory` with `EVENTS_PROVIDER=memory`
 * is that promise kept — `make dev` and `make test` boot the real application,
 * publish real events and run real subscribers, against nothing.
 *
 * **Its guarantee is genuinely weaker, and that is not a defect in the port.**
 * It publishes in-process: if the process dies between the write and the
 * dispatch, the event is gone. The outbox cannot be replaced by this and this
 * cannot be replaced by the outbox — they are different promises behind one
 * interface, and `eventstest` asserts only what they share.
 *
 * See `notes/patterns/events.md`.
 */

import { type Clock } from '../clock/index.js';
import { type IdGenerator } from '../id/index.js';
import { type Provenance } from '../provenance/index.js';
import { Envelope } from './envelope.js';
import { type Event } from './event.js';
import {
  matches,
  type Dispatcher,
  type Events,
  type Subscription,
} from './ports.js';

export interface MemoryOptions {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /**
   * Called when a subscriber throws.
   *
   * A failing subscriber must not veto the write and must not stop the others,
   * so the failure has nowhere to go but a report. Without one it is swallowed,
   * because a bus that crashed the publisher would make every subscriber a
   * co-owner of every write.
   */
  readonly onFailure?: (
    error: unknown,
    envelope: Envelope,
    subscriber: string,
  ) => void;
}

export interface MemoryEvents extends Events {
  /** Everything published, in order. For tests and for `doctor`. */
  published(): readonly Envelope[];
  /** Deliver an envelope again, deliberately. See the contract suite. */
  redeliver(envelope: Envelope): Promise<void>;
}

export function memoryEvents(options: MemoryOptions): MemoryEvents {
  const { clock, ids } = options;
  const subscriptions: Subscription[] = [];
  const published: Envelope[] = [];
  const pending: Envelope[] = [];

  /**
   * `subscriber:event` pairs already handled.
   *
   * At-least-once is the contract for **every** provider, so the memory bus
   * dedupes too. Per subscriber, not per event: two subscribers must each get
   * their own delivery, and one succeeding must not rob the other of it.
   *
   * In-process, so it is lost on restart — which is consistent with the rest of
   * this provider's promise and is exactly the durability difference the outbox
   * exists to remove.
   */
  const handled = new Set<string>();

  const dispatch = async (envelope: Envelope): Promise<void> => {
    for (const subscription of subscriptions) {
      if (!matches(subscription.pattern, envelope.name)) continue;

      const seen = `${subscription.name}:${envelope.id}`;
      if (handled.has(seen)) continue;

      try {
        await subscription.handle(envelope);
        // Recorded only on success: a subscriber that threw has not handled it,
        // and must see it again.
        handled.add(seen);
      } catch (error) {
        // One subscriber's failure is not another's, and it is never the
        // publisher's. There is no retry here: in-process delivery has nowhere
        // durable to retry from, which is precisely the difference the outbox
        // exists to remove.
        options.onFailure?.(error, envelope, subscription.name);
      }
    }
  };

  const dispatcher: Dispatcher = {
    async drain() {
      const batch = pending.splice(0);
      for (const envelope of batch) await dispatch(envelope);
      return batch.length;
    },
  };

  return {
    async publish(event: Event, provenance: Provenance) {
      const envelope = Envelope.seal(
        event,
        provenance,
        ids.uuid(),
        clock.now(),
      );
      published.push(envelope);
      pending.push(envelope);

      // Dispatched immediately, so publishing and delivery are one step for a
      // caller that never drains. `drain` stays available so a test can
      // separate the two, and so the shape matches the outbox's.
      await dispatcher.drain();
      return envelope;
    },

    subscribe(subscription) {
      subscriptions.push(subscription);
    },

    dispatcher,
    published: () => published,

    /**
     * Deliver an envelope again, on purpose.
     *
     * Exists so the contract suite can assert the honest property — the second
     * delivery is a no-op — rather than asserting a duplicate never arrives,
     * which would be claiming exactly-once.
     */
    async redeliver(envelope: Envelope) {
      await dispatch(envelope);
    },
  };
}
