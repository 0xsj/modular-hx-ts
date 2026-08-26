/**
 * The `Endpoint` aggregate. **`webhooks` domain.**
 *
 * A URL somebody else controls, a set of event names they want, and a secret
 * that proves a request came from here. Three rules live in this file and
 * nowhere else:
 *
 * - **A destination is checked before it is stored.** `https` only, no
 *   credentials in the URL, and no loopback or link-local host — see
 *   `destination.ts`. A webhook endpoint is a caller-supplied URL the server
 *   will fetch on a schedule, which is the definition of SSRF, and the check
 *   belongs at the moment the value becomes durable rather than at the moment
 *   it is used.
 * - **Subscriptions are event names, and `webhooks.` is refused.** See
 *   `events.ts`.
 * - **An endpoint that keeps failing disables itself.** Not to protect us —
 *   `breaker` does that — but because a dead endpoint accumulating a queue of
 *   deliveries nobody will ever read is a slow leak with a bill attached.
 *
 * See `notes/domain/webhooks.md`.
 */

import { invalid, notFound } from '../../../shared/errors/index.js';
import { checkDestination } from './destination.js';
import { WEBHOOK_PREFIX } from './events.js';
import { type EndpointId } from './ids.js';

/** Enabled, or disabled — by its owner or by this aggregate. */
export const EndpointState = {
  Enabled: 'enabled',
  Disabled: 'disabled',
} as const;

export type EndpointState = (typeof EndpointState)[keyof typeof EndpointState];

/**
 * **Why it is disabled**, which the owner needs and a boolean cannot carry.
 *
 * *You turned it off* and *we turned it off because it has been failing for
 * three days* are the same state and completely different messages, and the
 * second is the one somebody has to act on.
 */
export const DisabledBecause = {
  Owner: 'owner',
  ConsecutiveFailures: 'consecutive_failures',
} as const;

export type DisabledBecause =
  (typeof DisabledBecause)[keyof typeof DisabledBecause];

export interface EndpointState_ {
  readonly id: EndpointId;
  readonly ownerId: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly secretFingerprint: string;
  readonly state: EndpointState;
  readonly disabledBecause?: DisabledBecause;
  readonly consecutiveFailures: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

/**
 * How many consecutive failures disable an endpoint.
 *
 * **Consecutive, and reset by one success.** A count of total failures would
 * disable a busy endpoint that succeeds 99% of the time before it disabled a
 * dead one that has never worked, which is precisely backwards.
 */
export const FAILURES_BEFORE_DISABLE = 20;

export class Endpoint {
  #state: EndpointState_;
  readonly #baseVersion: number;

  private constructor(state: EndpointState_) {
    this.#state = state;
    this.#baseVersion = state.version;
  }

  static from(state: EndpointState_): Endpoint {
    return new Endpoint(state);
  }

  /**
   * Register a destination.
   *
   * The subscription list is **required and non-empty**: an endpoint
   * subscribed to nothing is one that will never fire, and accepting it
   * produces a support conversation rather than an error.
   */
  static register(
    id: EndpointId,
    ownerId: string,
    url: string,
    events: readonly string[],
    secretFingerprint: string,
    at: Date,
  ): Endpoint {
    checkDestination(url);

    const wanted = normalizeEvents(events);

    return new Endpoint({
      id,
      ownerId,
      url,
      events: wanted,
      secretFingerprint,
      state: EndpointState.Enabled,
      consecutiveFailures: 0,
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
  }

  get id(): EndpointId {
    return this.#state.id;
  }
  get ownerId(): string {
    return this.#state.ownerId;
  }
  get url(): string {
    return this.#state.url;
  }
  get events(): readonly string[] {
    return this.#state.events;
  }
  get secretFingerprint(): string {
    return this.#state.secretFingerprint;
  }
  get state(): EndpointState {
    return this.#state.state;
  }
  get disabledBecause(): DisabledBecause | undefined {
    return this.#state.disabledBecause;
  }
  get consecutiveFailures(): number {
    return this.#state.consecutiveFailures;
  }
  get createdAt(): Date {
    return this.#state.createdAt;
  }
  get updatedAt(): Date {
    return this.#state.updatedAt;
  }
  get version(): number {
    return this.#state.version;
  }
  get baseVersion(): number {
    return this.#baseVersion;
  }

  get isEnabled(): boolean {
    return this.#state.state === EndpointState.Enabled;
  }

  /**
   * Does this endpoint want that event?
   *
   * **Exact names, and one wildcard suffix.** `identity.user.*` matches
   * `identity.user.registered`; a bare `*` matches everything. Deliberately not
   * a regular expression — a subscription is data supplied by somebody else,
   * and a regular expression supplied by somebody else is a denial of service
   * you will run once per event per endpoint.
   */
  wants(event: string): boolean {
    return this.#state.events.some((pattern) => matches(pattern, event));
  }

  /** Point it somewhere else. The secret does not change; rotation is separate. */
  redirect(url: string, at: Date): void {
    checkDestination(url);
    if (url === this.#state.url) return;
    this.#state = {
      ...this.#state,
      url,
      updatedAt: at,
      version: this.#state.version + 1,
    };
  }

  resubscribe(events: readonly string[], at: Date): void {
    this.#state = {
      ...this.#state,
      events: normalizeEvents(events),
      updatedAt: at,
      version: this.#state.version + 1,
    };
  }

  rotateSecret(fingerprint: string, at: Date): void {
    this.#state = {
      ...this.#state,
      secretFingerprint: fingerprint,
      updatedAt: at,
      version: this.#state.version + 1,
    };
  }

  /** Idempotent, like `identity`'s. Disabling a disabled endpoint is not an error. */
  disable(because: DisabledBecause, at: Date): { readonly changed: boolean } {
    if (this.#state.state === EndpointState.Disabled) return { changed: false };
    this.#state = {
      ...this.#state,
      state: EndpointState.Disabled,
      disabledBecause: because,
      updatedAt: at,
      version: this.#state.version + 1,
    };
    return { changed: true };
  }

  enable(at: Date): { readonly changed: boolean } {
    if (this.#state.state === EndpointState.Enabled) return { changed: false };
    const { disabledBecause: _dropped, ...rest } = this.#state;
    this.#state = {
      ...rest,
      state: EndpointState.Enabled,
      // **Re-enabling forgives the count.** Otherwise an endpoint disabled at
      // twenty failures is re-enabled one failure from being disabled again,
      // and the owner who just fixed their server gets no runway at all.
      consecutiveFailures: 0,
      updatedAt: at,
      version: this.#state.version + 1,
    };
    return { changed: true };
  }

  /**
   * Record that a delivery landed.
   *
   * Returns whether anything changed, so a caller can skip a write: a healthy
   * endpoint delivering thousands of events would otherwise write a row per
   * event to set a zero to zero.
   */
  succeeded(at: Date): { readonly changed: boolean } {
    if (this.#state.consecutiveFailures === 0) return { changed: false };
    this.#state = {
      ...this.#state,
      consecutiveFailures: 0,
      updatedAt: at,
      version: this.#state.version + 1,
    };
    return { changed: true };
  }

  /** Record a failure, and disable at the threshold. */
  failed(at: Date): { readonly disabled: boolean } {
    const consecutiveFailures = this.#state.consecutiveFailures + 1;
    this.#state = {
      ...this.#state,
      consecutiveFailures,
      updatedAt: at,
      version: this.#state.version + 1,
    };

    if (
      consecutiveFailures >= FAILURES_BEFORE_DISABLE &&
      this.#state.state === EndpointState.Enabled
    ) {
      this.#state = {
        ...this.#state,
        state: EndpointState.Disabled,
        disabledBecause: DisabledBecause.ConsecutiveFailures,
      };
      return { disabled: true };
    }
    return { disabled: false };
  }

  toState(): EndpointState_ {
    return this.#state;
  }
}

/** The one refusal for an endpoint the caller may not see. */
export function noSuchEndpoint(): Error {
  // 404, never 403 — the same reasoning as `operations`: a 403 confirms the
  // endpoint exists and turns an id into an oracle for other people's
  // integrations.
  //
  // **And it must be `notFound`, not `conflict` wearing a `not-found` slug**,
  // which is what this was: `Kind.Conflict` maps to 409, so the refusal
  // carried the right *name* and the wrong *status* — a client branching on
  // status saw a conflict and would have retried it.
  return notFound('no such endpoint');
}

function normalizeEvents(events: readonly string[]): readonly string[] {
  const wanted = [...new Set(events.map((one) => one.trim()))].filter(
    (one) => one !== '',
  );

  if (wanted.length === 0) {
    throw invalid('an endpoint must subscribe to at least one event', [
      { field: 'events', message: 'must not be empty' },
    ]);
  }

  for (const pattern of wanted) {
    if (pattern.startsWith(WEBHOOK_PREFIX)) {
      throw invalid(`an endpoint may not subscribe to ${pattern}`, [
        {
          field: 'events',
          // The *reason* on the wire, because the alternative is a support
          // ticket asking why one prefix is special.
          message:
            'delivery outcomes are themselves events; subscribing to them is a loop',
        },
      ]);
    }
    if (pattern !== '*' && !/^[a-z0-9_.]+(\.\*)?$/.test(pattern)) {
      throw invalid(`not an event pattern: ${pattern}`, [
        {
          field: 'events',
          message: 'must be an event name, `prefix.*`, or `*`',
        },
      ]);
    }
  }

  return [...wanted].sort();
}

function matches(pattern: string, event: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return event.startsWith(pattern.slice(0, -1));
  return pattern === event;
}
