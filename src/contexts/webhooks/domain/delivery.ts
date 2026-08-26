/**
 * The `Delivery` aggregate. **`webhooks` domain.**
 *
 * One event, one endpoint, one row. It is the unit of retry and the unit of
 * evidence: *did they get it* is a question about a row here, not about a log
 * line somewhere.
 *
 * **Attempts are recorded, not counted.** A delivery that failed four times
 * holds four outcomes with their statuses and their instants, because the
 * question an owner actually asks is *what did my server say*, and a counter
 * cannot answer it. The list is capped — see `MAX_RECORDED` — since an
 * unbounded array in a row is a row that eventually cannot be read.
 *
 * See `notes/domain/webhooks.md`.
 */

import { conflict } from '../../../shared/errors/index.js';
import { type DeliveryId, type EndpointId } from './ids.js';

export const DeliveryState = {
  /** Waiting for its turn, or waiting out a backoff. */
  Pending: 'pending',
  Succeeded: 'succeeded',
  /** Out of attempts. Terminal, and the only state a human is asked about. */
  Exhausted: 'exhausted',
} as const;

export type DeliveryState = (typeof DeliveryState)[keyof typeof DeliveryState];

export interface Attempt {
  readonly at: Date;
  /** Absent when the request never got a response — DNS, refused, timeout. */
  readonly status?: number;
  /** Never the upstream body: see `httpclient`. A reason, not a transcript. */
  readonly error?: string;
  readonly tookMs: number;
}

/**
 * How many attempts are kept on the row.
 *
 * Ten is more than `MAX_ATTEMPTS`, so in normal operation nothing is ever
 * dropped and the cap is a guard rather than a policy. It matters for a
 * delivery replayed by hand a hundred times.
 */
export const MAX_RECORDED = 10;

/** Attempts before a delivery is exhausted. */
export const MAX_ATTEMPTS = 6;

export interface DeliveryState_ {
  readonly id: DeliveryId;
  readonly endpointId: EndpointId;
  readonly eventId: string;
  readonly eventName: string;
  /** The exact bytes that were signed, kept so a replay is byte-identical. */
  readonly payload: string;
  readonly state: DeliveryState;
  readonly attempts: readonly Attempt[];
  /**
   * Every attempt ever made, which `attempts` cannot tell you once it is
   * capped — and the number an owner means by *how many times did you try*.
   */
  readonly totalAttempts: number;
  /**
   * Attempts against the **current** budget: since it was queued, or since it
   * was last replayed.
   *
   * **This was `attempts.length`, and that was two bugs in one expression.**
   * The list is capped at `MAX_RECORDED`, so past the cap the count stopped
   * moving; and a replay left it where the exhaustion had put it, so a replayed
   * delivery got exactly one further attempt before exhausting again — a replay
   * button that did not replay. Separating *history*, *ever*, and *this round*
   * is three fields because they are three questions.
   */
  readonly attemptsThisRound: number;
  readonly nextAttemptAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export class Delivery {
  #state: DeliveryState_;
  readonly #baseVersion: number;

  private constructor(state: DeliveryState_) {
    this.#state = state;
    this.#baseVersion = state.version;
  }

  static from(state: DeliveryState_): Delivery {
    return new Delivery(state);
  }

  static queue(
    id: DeliveryId,
    endpoint: EndpointId,
    event: { readonly id: string; readonly name: string },
    payload: string,
    at: Date,
  ): Delivery {
    return new Delivery({
      id,
      endpointId: endpoint,
      eventId: event.id,
      eventName: event.name,
      payload,
      state: DeliveryState.Pending,
      attempts: [],
      totalAttempts: 0,
      attemptsThisRound: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
      version: 1,
    });
  }

  get id(): DeliveryId {
    return this.#state.id;
  }
  get endpointId(): EndpointId {
    return this.#state.endpointId;
  }
  get eventId(): string {
    return this.#state.eventId;
  }
  get eventName(): string {
    return this.#state.eventName;
  }
  get payload(): string {
    return this.#state.payload;
  }
  get state(): DeliveryState {
    return this.#state.state;
  }
  get attempts(): readonly Attempt[] {
    return this.#state.attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this.#state.nextAttemptAt;
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

  get isTerminal(): boolean {
    return this.#state.state !== DeliveryState.Pending;
  }

  /** How many times it has been tried, which is not how many are recorded. */
  get attemptCount(): number {
    return this.#state.totalAttempts;
  }

  succeed(attempt: Attempt): void {
    this.#settle();
    const { nextAttemptAt: _cleared, ...rest } = this.#state;
    this.#state = {
      ...rest,
      state: DeliveryState.Succeeded,
      attempts: record(this.#state.attempts, attempt),
      totalAttempts: this.#state.totalAttempts + 1,
      attemptsThisRound: this.#state.attemptsThisRound + 1,
      updatedAt: attempt.at,
      version: this.#state.version + 1,
    };
  }

  /**
   * A failed attempt. **`retryAt` is computed by the caller and passed in.**
   *
   * `../MODULES.md` §L1: nothing in this collection computes an interval from a
   * reading of the clock it took itself. The backoff schedule is `retry`'s and
   * the instant is the caller's; this aggregate decides only *whether* there is
   * another attempt, which is the part that is domain knowledge.
   */
  fail(attempt: Attempt, retryAt: Date): { readonly exhausted: boolean } {
    this.#settle();

    const attempts = record(this.#state.attempts, attempt);
    const attemptsThisRound = this.#state.attemptsThisRound + 1;
    const totalAttempts = this.#state.totalAttempts + 1;

    if (attemptsThisRound >= MAX_ATTEMPTS) {
      const { nextAttemptAt: _cleared, ...rest } = this.#state;
      this.#state = {
        ...rest,
        state: DeliveryState.Exhausted,
        attempts,
        totalAttempts,
        attemptsThisRound,
        updatedAt: attempt.at,
        version: this.#state.version + 1,
      };
      return { exhausted: true };
    }

    this.#state = {
      ...this.#state,
      attempts,
      totalAttempts,
      attemptsThisRound,
      nextAttemptAt: retryAt,
      updatedAt: attempt.at,
      version: this.#state.version + 1,
    };
    return { exhausted: false };
  }

  /**
   * Try an exhausted delivery again, by hand.
   *
   * **The attempt history survives**, because the question *did this ever
   * work* is answered by the whole row and a replay that cleared it would be
   * destroying the evidence somebody replayed it to gather.
   */
  replay(at: Date): void {
    if (this.#state.state === DeliveryState.Succeeded) {
      throw conflict('that delivery already succeeded', {
        problem: 'version-conflict',
      });
    }
    if (this.#state.state === DeliveryState.Pending) {
      throw conflict('that delivery has not finished yet', {
        problem: 'version-conflict',
      });
    }
    this.#state = {
      ...this.#state,
      state: DeliveryState.Pending,
      // **A fresh budget** — that is what a replay is. The history stays.
      attemptsThisRound: 0,
      nextAttemptAt: at,
      updatedAt: at,
      version: this.#state.version + 1,
    };
  }

  toState(): DeliveryState_ {
    return this.#state;
  }

  /**
   * **A terminal delivery never moves**, which is the same guard `operations`
   * carries and for the same reason: a worker whose lease expired mid-flight
   * runs the job twice, and the second run must not overwrite the first
   * answer.
   */
  #settle(): void {
    if (this.isTerminal) {
      throw conflict(`delivery ${this.#state.id} has already finished`, {
        problem: 'version-conflict',
      });
    }
  }
}

function record(
  attempts: readonly Attempt[],
  one: Attempt,
): readonly Attempt[] {
  // **The newest are kept, not the oldest.** Debugging a delivery is asking
  // what happened *last*.
  return [...attempts, one].slice(-MAX_RECORDED);
}
