/**
 * Long-running operations: **202, `Location`, poll, cancel.** L3 capability.
 *
 * `../../../CONFORMANCE.md` §4.11: an async request returns 202 with a
 * `Location`, and polling that location reports a terminal state exactly once.
 *
 * **A ×3 harvest.** v1 had this shape copied into three places, and the copies
 * disagreed about the one thing that matters — what happens after a terminal
 * state. This is the first time it is built once.
 *
 * **Cancellation is a state, not a kill.** There is no way to stop a worker
 * from here and there should not be: a cancelled operation stops *being worked*
 * and says so, and a worker mid-write finds out at its next checkpoint. A
 * module that promised to interrupt would be promising something no queue and
 * no filesystem can deliver.
 *
 * **The result is a reference, never the artifact.** `succeeded` carries an
 * `href`, and whatever serves that href is a separate route with its own
 * authorization, checked at download time rather than at creation. An operation
 * that embedded bytes would be an operation whose poll response grew without
 * limit and whose authorization was decided hours before the read.
 *
 * See `notes/patterns/operations.md`.
 */

import { conflict, notFound } from '../errors/index.js';

/**
 * The states, and the transitions between them.
 *
 * Closed and small. `running` is the only non-terminal one, which is what makes
 * *reports a terminal state exactly once* checkable: everything else is final,
 * so a second poll of a terminal operation returns the same bytes.
 */
export const OperationState = {
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

export type OperationState =
  (typeof OperationState)[keyof typeof OperationState];

const TERMINAL: readonly OperationState[] = [
  OperationState.Succeeded,
  OperationState.Failed,
  OperationState.Cancelled,
];

export function isTerminal(state: OperationState): boolean {
  return TERMINAL.includes(state);
}

export interface OperationResult {
  /** Where the artifact is. **A reference, never the bytes.** */
  readonly href: string;
  readonly contentType?: string;
  readonly size?: number;
}

export interface OperationState_ {
  readonly id: string;
  /** What kind of work this is. The owning context's word. */
  readonly kind: string;
  readonly state: OperationState;
  /** Who asked. Authorization on a poll compares against this. */
  readonly ownerId: string;
  readonly tenant: string;
  readonly result?: OperationResult | undefined;
  /** Why it failed. Safe to show the caller who started it. */
  readonly error?: string | undefined;
  readonly startedAt: Date;
  readonly finishedAt?: Date | undefined;
  readonly version: number;
}

/**
 * The record. **Not an aggregate in anybody's domain**, which is the point of
 * it being here: three contexts would otherwise each have one, and the one that
 * drifted would be the one that let a terminal state move.
 */
export class Operation {
  #state: OperationState;
  #result: OperationResult | undefined;
  #error: string | undefined;
  #finishedAt: Date | undefined;
  #version: number;

  readonly id: string;
  readonly kind: string;
  readonly ownerId: string;
  readonly tenant: string;
  readonly startedAt: Date;
  readonly baseVersion: number;

  private constructor(state: OperationState_) {
    this.id = state.id;
    this.kind = state.kind;
    this.ownerId = state.ownerId;
    this.tenant = state.tenant;
    this.startedAt = state.startedAt;
    this.baseVersion = state.version;

    this.#state = state.state;
    this.#result = state.result;
    this.#error = state.error;
    this.#finishedAt = state.finishedAt;
    this.#version = state.version;
  }

  static start(
    id: string,
    kind: string,
    ownerId: string,
    tenant: string,
    at: Date,
  ): Operation {
    return new Operation({
      id,
      kind,
      state: OperationState.Running,
      ownerId,
      tenant,
      startedAt: at,
      version: 1,
    });
  }

  static from(state: OperationState_): Operation {
    return new Operation(state);
  }

  get state(): OperationState {
    return this.#state;
  }
  get result(): OperationResult | undefined {
    return this.#result;
  }
  get error(): string | undefined {
    return this.#error;
  }
  get finishedAt(): Date | undefined {
    return this.#finishedAt;
  }
  get version(): number {
    return this.#version;
  }
  get terminal(): boolean {
    return isTerminal(this.#state);
  }

  /**
   * Finish it. **A terminal state never moves.**
   *
   * The rule the three copies disagreed about, and the reason a poll can
   * promise *exactly once*: a worker that finishes after a cancellation, or
   * that retries a job whose operation already succeeded, must not overwrite
   * what a caller has already read.
   */
  #settle(
    state: OperationState,
    at: Date,
    detail: { result?: OperationResult; error?: string } = {},
  ): void {
    if (this.terminal) {
      throw conflict(`operation ${this.id} is already ${this.#state}`, {
        problem: 'operation-terminal',
      });
    }
    this.#state = state;
    this.#result = detail.result;
    this.#error = detail.error;
    this.#finishedAt = at;
    this.#version += 1;
  }

  succeed(result: OperationResult, at: Date): void {
    this.#settle(OperationState.Succeeded, at, { result });
  }

  fail(error: string, at: Date): void {
    this.#settle(OperationState.Failed, at, { error });
  }

  /**
   * Cancel. **Idempotent, and it does not stop anything.**
   *
   * Cancelling an already-cancelled operation is not an error — a client that
   * pressed the button twice is a client, not a failure. Cancelling a
   * *succeeded* one is refused, because the artifact exists and pretending it
   * does not is worse than saying no.
   */
  cancel(at: Date): { readonly changed: boolean } {
    if (this.#state === OperationState.Cancelled) return { changed: false };
    this.#settle(OperationState.Cancelled, at);
    return { changed: true };
  }

  /**
   * Should a worker stop? **Checked at a checkpoint, not enforced.**
   *
   * This is the whole of what cancellation can mean to work already running: a
   * worker asks between units and stops if the answer is yes. Nothing here can
   * interrupt a syscall, and a module claiming otherwise would be lying to
   * every caller that believed it.
   */
  get abandoned(): boolean {
    return this.#state === OperationState.Cancelled;
  }

  toState(): OperationState_ {
    return {
      id: this.id,
      kind: this.kind,
      state: this.#state,
      ownerId: this.ownerId,
      tenant: this.tenant,
      ...(this.#result === undefined ? {} : { result: this.#result }),
      ...(this.#error === undefined ? {} : { error: this.#error }),
      startedAt: this.startedAt,
      ...(this.#finishedAt === undefined
        ? {}
        : { finishedAt: this.#finishedAt }),
      version: this.#version,
    };
  }
}

/** Where a caller polls. The `Location` a 202 carries. */
export function locationOf(id: string): string {
  return `/v1/operations/${id}`;
}

/** The one refusal for an operation somebody may not see. */
export function invisible(): Error {
  // **404, never 403.** A 403 confirms the operation exists and turns any id
  // into an oracle for what other people are exporting.
  return notFound('no such operation');
}
