/**
 * One contract suite; every provider passes it. **Test tooling** — rule `S3`.
 *
 * **What it deliberately does not assert: durability across process death.**
 * The memory bus publishes in-process, so an event is gone if the process dies
 * between the write and the dispatch; the outbox writes inside the caller's
 * transaction and cannot lose one. That difference is real, it is the reason
 * the outbox exists, and contorting the suite to make the two look identical
 * would assert a promise one provider does not make. It is recorded in
 * `notes/patterns/events.md` instead.
 *
 * What they **do** share, and what is asserted here:
 *
 * 1. publish reaches subscribers
 * 2. delivery is at-least-once, and a redelivery is a no-op
 * 3. a failing subscriber vetoes neither the write nor the other subscribers
 * 4. envelope shape and provenance survive a round trip
 * 5. a subscriber **derives** — correlation from the envelope, causation from
 *    the event id, a fresh request id
 */

import { describe, expect, it } from 'vitest';
import { unwrap } from '../result/index.js';
import { type Envelope, provenanceFor } from './envelope.js';
import { event } from './event.js';
import { type Events } from './ports.js';
import { type Provenance } from '../provenance/index.js';

export interface Subject {
  readonly events: Events;
  readonly name: string;
  /** Provenance for a publish, as a context would supply it. */
  readonly provenance: () => Provenance;
  /** Deliver whatever is pending. A no-op where publish already delivered. */
  readonly settle: () => Promise<void> | void;
  /** Deliver `envelope` a second time on purpose. */
  readonly redeliver: (envelope: Envelope) => Promise<void>;
  readonly reset?: () => Promise<void>;
}

const registered = unwrap(
  event('identity.user.registered', { user_id: 'u1', email: 'a@example.com' }),
);

export function eventsContract(subject: () => Subject): void {
  describe('publish reaches subscribers', () => {
    it('delivers to a subscriber on the name', async () => {
      const s = subject();
      const seen: string[] = [];
      s.events.subscribe({
        name: 'welcome',
        pattern: 'identity.user.registered',
        handle: (env) => {
          seen.push(env.name);
        },
      });

      await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(seen).toEqual(['identity.user.registered']);
    });

    it('delivers to a context prefix subscriber', async () => {
      const s = subject();
      const seen: string[] = [];
      s.events.subscribe({
        name: 'audit',
        pattern: 'identity.*',
        handle: (env) => {
          seen.push(env.name);
        },
      });

      await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(seen).toEqual(['identity.user.registered']);
    });

    it('delivers to every matching subscriber, not just the first', async () => {
      // Fan-out with nothing failing. `a failing subscriber does not stop the
      // subscribers beside it` covers the harder case and would pass with a
      // provider that stopped after the *second*; this is the plain one.
      const s = subject();
      const seen: string[] = [];
      for (const name of ['audit', 'welcome', 'search']) {
        s.events.subscribe({
          name,
          pattern: 'identity.*',
          handle: () => {
            seen.push(name);
          },
        });
      }

      await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(seen.sort()).toEqual(['audit', 'search', 'welcome']);
    });

    it('publishes with no subscribers at all', async () => {
      // Different from a subscriber that did not match: there is nobody to
      // iterate. A provider that assumed at least one would fail here and
      // nowhere else, and the first context to publish before anything
      // subscribes is a boot-order accident rather than a code change.
      const s = subject();

      const envelope = await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(envelope.name).toBe('identity.user.registered');
    });

    it('does not deliver to a subscriber that did not ask', async () => {
      const s = subject();
      const seen: string[] = [];
      s.events.subscribe({
        name: 'orgs',
        pattern: 'orgs.*',
        handle: () => {
          seen.push('called');
        },
      });

      await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(seen).toEqual([]);
    });
  });

  describe('delivery is at-least-once', () => {
    it('is a no-op the second time the same event arrives', async () => {
      // The honest test: deliver the same event twice **on purpose** and assert
      // the second does nothing. Asserting that a duplicate never arrives would
      // be claiming exactly-once, which no provider here offers.
      const s = subject();
      let handled = 0;
      s.events.subscribe({
        name: 'counter',
        pattern: 'identity.*',
        handle: () => {
          handled += 1;
        },
      });

      const envelope = await s.events.publish(registered, s.provenance());
      await s.settle();
      await s.redeliver(envelope);

      expect(handled).toBe(1);
    });
  });

  describe('dedupe does not suppress a retry', () => {
    it('replays a subscriber that failed while skipping one that did not', async () => {
      // The subtle one, and nobody specified it. An idempotent consumer must
      // dedupe a **redelivery** without also swallowing a legitimate **retry**
      // after a failure. Get it wrong and a failed handler never runs again,
      // silently — the write succeeded, the event was published, and one
      // subscriber simply never happened.
      //
      // Both halves are asserted here, because each alone passes against a
      // broken implementation: recording the dedupe unconditionally passes the
      // first, and never recording it passes the second.
      const s = subject();
      let succeeded = 0;
      let attempts = 0;

      s.events.subscribe({
        name: 'succeeds',
        pattern: 'identity.*',
        handle: () => {
          succeeded += 1;
        },
      });
      s.events.subscribe({
        name: 'fails-once',
        pattern: 'identity.*',
        handle: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('deliberate, first attempt only');
        },
      });

      const envelope = await s.events.publish(registered, s.provenance());
      await s.settle();
      await s.redeliver(envelope);

      // Dedupe held: the one that succeeded is not asked twice.
      expect(succeeded).toBe(1);
      // Dedupe did not overreach: the one that failed is asked again.
      expect(attempts).toBe(2);
    });
  });

  describe('a failing subscriber', () => {
    it('does not veto the write', async () => {
      const s = subject();
      s.events.subscribe({
        name: 'always-fails',
        pattern: 'identity.*',
        handle: () => {
          throw new Error('deliberate');
        },
      });

      // The publish resolves. A subscriber is not a co-owner of the write.
      const envelope = await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(envelope.name).toBe('identity.user.registered');
    });

    it('does not stop the subscribers beside it', async () => {
      const s = subject();
      const seen: string[] = [];
      s.events.subscribe({
        name: 'always-fails',
        pattern: 'identity.*',
        handle: () => {
          throw new Error('deliberate');
        },
      });
      s.events.subscribe({
        name: 'still-runs',
        pattern: 'identity.*',
        handle: () => {
          seen.push('ran');
        },
      });

      await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(seen).toEqual(['ran']);
    });
  });

  describe('failure is contained whatever shape it takes', () => {
    it('contains a rejected promise and a thrown non-Error alike', async () => {
      // Two distinct paths in JavaScript: a synchronous `throw` never creates a
      // promise, and a rejection arrives after the handler returned. A provider
      // that only wrapped one of them would look correct in every test written
      // with the other. A non-Error is thrown on purpose too — `catch` receives
      // whatever was thrown, and code that assumes `.message` fails there.
      const s = subject();
      const seen: string[] = [];

      s.events.subscribe({
        name: 'rejects',
        pattern: 'identity.*',
        handle: () => Promise.reject(new Error('deliberate')),
      });
      s.events.subscribe({
        name: 'throws-a-string',
        pattern: 'identity.*',
        handle: () => {
          /* eslint-disable-next-line @typescript-eslint/only-throw-error --
             Throwing a non-Error is the case under test. A provider whose catch
             assumes `.message` fails exactly here, and the lint rule that
             forbids writing it is the reason nobody writes the test. */
          throw 'deliberate';
        },
      });
      s.events.subscribe({
        name: 'still-runs',
        pattern: 'identity.*',
        handle: () => {
          seen.push('ran');
        },
      });

      const envelope = await s.events.publish(registered, s.provenance());
      await s.settle();

      expect(envelope.name).toBe('identity.user.registered');
      expect(seen).toEqual(['ran']);
    });
  });

  describe('the envelope survives a round trip', () => {
    it('keeps its shape, payload and provenance', async () => {
      const s = subject();
      let received: Envelope | undefined;
      s.events.subscribe({
        name: 'capture',
        pattern: 'identity.*',
        handle: (env) => {
          received = env;
        },
      });

      const provenance = s.provenance();
      const sent = await s.events.publish(registered, provenance);
      await s.settle();

      expect(received?.id).toBe(sent.id);
      expect(received?.name).toBe('identity.user.registered');
      expect(received?.payload).toEqual({
        user_id: 'u1',
        email: 'a@example.com',
      });
      expect(received?.provenance.correlationId).toBe(provenance.correlationId);
      expect(String(received?.provenance.actor)).toBe(String(provenance.actor));
      expect(received?.occurredAt).toBeInstanceOf(Date);
    });

    it('cannot be published without provenance — rule M5', async () => {
      // M5's detect clause is *publish goes through the envelope constructor,
      // which requires them*. A type stops a TypeScript caller; this is the
      // guard for everyone else, and it belongs in the shared suite because a
      // provider that built envelopes its own way would slip past a test that
      // only ever ran against one of them.
      const s = subject();

      await expect(
        s.events.publish(registered, undefined as never),
      ).rejects.toThrow();
    });

    it('carries provenance at all — rule M5', async () => {
      const s = subject();
      const sent = await s.events.publish(registered, s.provenance());

      const wire = sent.toJSON();
      expect(wire.provenance.request_id).toBeDefined();
      expect(wire.provenance.correlation_id).toBeDefined();
      expect(wire.provenance.actor).toBeDefined();
    });
  });

  describe('a subscriber derives, it never mints', () => {
    it('takes correlation from the envelope and causation from the event id', async () => {
      // PROVENANCE.md §4, and the one that is expensive to discover late. If a
      // subscriber minted instead, the causal chain would break at every
      // context boundary and the audit and lineage graphs would disconnect —
      // conformance case 38, and what invariant I6 exists to prevent.
      const s = subject();
      let derived: Provenance | undefined;
      s.events.subscribe({
        name: 'deriver',
        pattern: 'identity.*',
        handle: (env) => {
          derived = provenanceFor(env);
        },
      });

      const parent = s.provenance();
      const sent = await s.events.publish(registered, parent);
      await s.settle();

      expect(derived?.correlationId).toBe(parent.correlationId);
      expect(derived?.causationId).toBe(sent.id);
      expect(derived?.requestId).not.toBe(parent.requestId);
      expect(derived?.requestId).not.toBe(sent.id);
      // The actor is inherited: the subscriber acts for whoever caused this.
      expect(String(derived?.actor)).toBe(String(parent.actor));
    });
  });
}
