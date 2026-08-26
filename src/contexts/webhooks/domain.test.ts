/**
 * The `webhooks` domain, on its own. **No ports, no adapters, no HTTP.**
 *
 * `S7` says this directory imports only `errors`, so a test of it needs
 * nothing either — which is the property being demonstrated as much as the
 * behaviour.
 */

import { describe, expect, it } from 'vitest';
import {
  Delivery,
  DisabledBecause,
  Endpoint,
  EndpointState,
  FAILURES_BEFORE_DISABLE,
  MAX_ATTEMPTS,
  MAX_RECORDED,
  checkDestination,
  deliveryId,
  endpointId,
  signedMessage,
  timestampFor,
} from './domain/index.js';

const at = new Date('2026-08-26T09:00:00.000Z');
const later = (ms: number): Date => new Date(at.getTime() + ms);

const anEndpoint = (
  events: readonly string[] = ['identity.user.registered'],
): Endpoint =>
  Endpoint.register(
    endpointId('01a03c00-0000-7000-8000-000000000001'),
    'owner-1',
    'https://example.test/hooks',
    events,
    'sha256:fingerprint',
    at,
  );

describe('the destination check — every rule closes one door', () => {
  it('refuses http, because a signed body is not an encrypted one', () => {
    expect(() => {
      checkDestination('http://example.test/hooks');
    }).toThrow();
  });

  it('refuses credentials in the URL', () => {
    // They would land in a column, in a list response, and in every log line
    // that prints the destination.
    expect(() => {
      checkDestination('https://user:pass@example.test/hooks');
    }).toThrow();
  });

  it('refuses loopback and the metadata address', () => {
    for (const url of [
      'https://127.0.0.1/hooks',
      'https://localhost/hooks',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/hooks',
      'https://10.0.0.5/hooks',
      'https://192.168.1.1/hooks',
      'https://172.16.0.1/hooks',
    ]) {
      expect(() => {
        checkDestination(url);
      }, url).toThrow();
    }
  });

  it('refuses a loopback address wearing a v6 hat', () => {
    // `::ffff:127.0.0.1` is the same address, and a check that only knew the
    // dotted form would let it through — which is the entire trick.
    expect(() => {
      checkDestination('https://[::ffff:127.0.0.1]/hooks');
    }).toThrow();
  });

  it('refuses a fragment, which is never sent', () => {
    // Storing one stores a destination that is not the destination.
    expect(() => {
      checkDestination('https://example.test/h#frag');
    }).toThrow();
  });

  it('accepts an ordinary https URL', () => {
    expect(() => {
      checkDestination('https://example.test/hooks?tenant=7');
    }).not.toThrow();
  });

  it('does not pretend to have solved SSRF', () => {
    // A name resolving to a private address passes every check in this file,
    // and saying so in a test is the honest place to say it: the complete
    // answer pins the resolved address at connect time and belongs to the
    // dialer, not the domain.
    expect(() => {
      checkDestination('https://internal.corp.example/hooks');
    }).not.toThrow();
  });
});

describe('subscriptions', () => {
  it('refuses an endpoint that subscribes to nothing', () => {
    expect(() => anEndpoint([])).toThrow();
  });

  it('REFUSES the webhooks prefix, because it is a loop', () => {
    // A delivery that fails publishes a failure event, which produces a
    // delivery, which fails. One publish per attempt, growing.
    expect(() => anEndpoint(['webhooks.delivery.failed'])).toThrow();
    expect(() => anEndpoint(['webhooks.*'])).toThrow();
  });

  it('matches an exact name, a prefix wildcard, and everything', () => {
    expect(
      anEndpoint(['identity.user.registered']).wants(
        'identity.user.registered',
      ),
    ).toBe(true);
    expect(
      anEndpoint(['identity.user.*']).wants('identity.user.registered'),
    ).toBe(true);
    expect(anEndpoint(['*']).wants('orgs.member.joined')).toBe(true);
    expect(anEndpoint(['identity.user.*']).wants('orgs.member.joined')).toBe(
      false,
    );
  });

  it('does not let a subscription be a regular expression', () => {
    // A pattern is data somebody else supplied, and a regular expression
    // somebody else supplied is a denial of service run once per event per
    // endpoint.
    expect(() => anEndpoint(['identity\\.user\\.(a|b)+$'])).toThrow();
  });

  it('deduplicates and sorts, so two spellings are one subscription', () => {
    const endpoint = anEndpoint(['b.event', 'a.event', 'b.event']);

    expect(endpoint.events).toEqual(['a.event', 'b.event']);
  });
});

describe('an endpoint that keeps failing disables itself', () => {
  it('disables at the threshold, and says why', () => {
    const endpoint = anEndpoint();

    let disabled = false;
    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) {
      disabled = endpoint.failed(later(i)).disabled;
    }

    expect(disabled).toBe(true);
    expect(endpoint.state).toBe(EndpointState.Disabled);
    // *You turned it off* and *it has been failing for three days* are the same
    // state and completely different messages.
    expect(endpoint.disabledBecause).toBe(DisabledBecause.ConsecutiveFailures);
  });

  it('counts CONSECUTIVE failures — one success resets it', () => {
    // Total failures would disable a busy endpoint that succeeds 99% of the
    // time before a dead one that has never worked.
    const endpoint = anEndpoint();

    for (let i = 0; i < FAILURES_BEFORE_DISABLE - 1; i++) endpoint.failed(at);
    endpoint.succeeded(at);
    const outcome = endpoint.failed(at);

    expect(outcome.disabled).toBe(false);
    expect(endpoint.consecutiveFailures).toBe(1);
  });

  it('writes nothing when a healthy endpoint succeeds again', () => {
    // Otherwise a busy endpoint writes a row per event to set a zero to zero.
    expect(anEndpoint().succeeded(at).changed).toBe(false);
  });

  it('forgives the count when it is re-enabled', () => {
    // Otherwise the owner who just fixed their server is one failure from
    // being disabled again and gets no runway at all.
    const endpoint = anEndpoint();
    for (let i = 0; i < FAILURES_BEFORE_DISABLE; i++) endpoint.failed(at);

    endpoint.enable(at);

    expect(endpoint.consecutiveFailures).toBe(0);
    expect(endpoint.disabledBecause).toBeUndefined();
  });

  it('is idempotent about disabling', () => {
    const endpoint = anEndpoint();

    expect(endpoint.disable(DisabledBecause.Owner, at).changed).toBe(true);
    expect(endpoint.disable(DisabledBecause.Owner, at).changed).toBe(false);
  });
});

describe('a delivery', () => {
  const queue = (): Delivery =>
    Delivery.queue(
      deliveryId('01a03c00-0000-7000-8000-00000000000d'),
      endpointId('01a03c00-0000-7000-8000-000000000001'),
      { id: 'evt-1', name: 'identity.user.registered' },
      '{"hello":"world"}',
      at,
    );

  it('exhausts after MAX_ATTEMPTS and stops asking for another', () => {
    const delivery = queue();

    let exhausted = false;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      exhausted = delivery.fail(
        { at: later(i), status: 500, tookMs: 3 },
        later(i + 1000),
      ).exhausted;
    }

    expect(exhausted).toBe(true);
    expect(delivery.nextAttemptAt).toBeUndefined();
  });

  it('NEVER moves once terminal', () => {
    // A worker whose lease expired mid-flight runs the job twice, and the
    // second run must not overwrite the first answer.
    const delivery = queue();
    delivery.succeed({ at, status: 200, tookMs: 4 });

    expect(() => delivery.fail({ at, status: 500, tookMs: 1 }, at)).toThrow();
    expect(() => {
      delivery.succeed({ at, status: 200, tookMs: 1 });
    }).toThrow();
  });

  it('records what the server said, not just that it failed', () => {
    const delivery = queue();
    delivery.fail({ at, status: 503, tookMs: 12 }, later(1000));

    expect(delivery.attempts[0]?.status).toBe(503);
    expect(delivery.attemptCount).toBe(1);
  });

  it('caps the recorded attempts and keeps the NEWEST', () => {
    // Debugging a delivery is asking what happened last.
    const delivery = queue();
    // Exhaust the first budget, replay, and spend part of a second — the only
    // way to make more attempts than `MAX_RECORDED` holds.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      delivery.fail({ at: later(i), status: 500, tookMs: 1 }, later(i + 1));
    }
    delivery.replay(later(999));
    const extra = MAX_RECORDED - MAX_ATTEMPTS + 1;
    for (let i = 0; i < extra; i++) {
      delivery.fail({ at: later(i), status: 400 + i, tookMs: 1 }, later(i + 1));
    }

    expect(delivery.attemptCount).toBe(MAX_ATTEMPTS + extra);
    expect(delivery.attempts).toHaveLength(MAX_RECORDED);
    expect(delivery.attempts.at(-1)?.status).toBe(400 + extra - 1);
  });

  it('gives a replayed delivery a FRESH budget, not one attempt', () => {
    // This was `attempts.length` against `MAX_ATTEMPTS`, so a replayed
    // delivery exhausted again on its first attempt — a replay button that did
    // not replay, and invisible until a test counted the attempts after one.
    const delivery = queue();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      delivery.fail({ at, status: 500, tookMs: 1 }, later(i));
    }
    delivery.replay(later(999));

    let exhausted = false;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      exhausted = delivery.fail(
        { at, status: 500, tookMs: 1 },
        later(i),
      ).exhausted;
    }

    expect(exhausted).toBe(true);
    expect(delivery.attemptCount).toBe(MAX_ATTEMPTS * 2);
  });

  it('replays an exhausted delivery and KEEPS its history', () => {
    // Somebody replayed it to gather evidence; clearing the history destroys
    // exactly what they were gathering.
    const delivery = queue();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      delivery.fail({ at, status: 500, tookMs: 1 }, later(i));
    }

    delivery.replay(later(9999));

    expect(delivery.state).toBe('pending');
    expect(delivery.attemptCount).toBe(MAX_ATTEMPTS);
  });

  it('refuses to replay one that succeeded, or one still running', () => {
    const done = queue();
    done.succeed({ at, status: 200, tookMs: 1 });
    expect(() => {
      done.replay(at);
    }).toThrow();

    expect(() => {
      queue().replay(at);
    }).toThrow();
  });
});

describe('what gets signed', () => {
  it('is id, timestamp and body, separated', () => {
    // A receiver reimplements this and nothing else, so it is asserted
    // literally rather than through a signer.
    expect(signedMessage('d-1', 1700000000, '{"a":1}')).toBe(
      'd-1.1700000000.{"a":1}',
    );
  });

  it('cannot be confused by moving the boundary', () => {
    // Concatenation with no separator makes ("a","bc") and ("ab","c") the same
    // bytes. With one, they cannot be.
    expect(signedMessage('a', 1, 'bc')).not.toBe(signedMessage('a1', 1, 'bc'));
  });

  it('signs whole seconds, because that is what the header carries', () => {
    // Signing millis and sending seconds is a signature that never verifies,
    // and it looks completely fine in a transcript.
    expect(timestampFor(new Date('2026-08-26T09:00:00.750Z'))).toBe(
      Math.floor(new Date('2026-08-26T09:00:00.750Z').getTime() / 1000),
    );
  });
});
