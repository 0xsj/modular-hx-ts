/**
 * `operations`. **The rule the three copies disagreed about is the test.**
 *
 * A terminal state never moves. Everything else in this module is bookkeeping,
 * and that one property is what lets a poll promise *reports a terminal state
 * exactly once* — conformance case 46.
 */

import { describe, expect, it } from 'vitest';
import { fakeClock, seconds } from '../clock/index.js';
import { Kind, kindOf } from '../errors/index.js';
import {
  Operation,
  OperationState,
  isTerminal,
  locationOf,
  memoryOperationStore,
  memoryOperations,
} from './index.js';

const clock = fakeClock();
const started = () =>
  Operation.start('op-1', 'export', 'user-1', 'acme', clock.now());

describe('starting', () => {
  it('is running, with no result and no error', () => {
    const op = started();

    expect(op.state).toBe(OperationState.Running);
    expect(op.result).toBeUndefined();
    expect(op.terminal).toBe(false);
  });

  it('has a location a caller can poll', () => {
    expect(locationOf('op-1')).toBe('/v1/operations/op-1');
  });
});

describe('a terminal state never moves — the ×3 disagreement', () => {
  it('succeeds once', () => {
    const op = started();
    op.succeed({ href: '/v1/exports/op-1/download' }, clock.now());

    expect(op.state).toBe(OperationState.Succeeded);
    expect(() => {
      op.succeed({ href: '/other' }, clock.now());
    }).toThrow();
  });

  it('refuses a failure after a success', () => {
    // The retry case: a worker whose job is redelivered after the operation
    // already succeeded must not overwrite what a caller has read.
    const op = started();
    op.succeed({ href: '/v1/x' }, clock.now());

    const thrown = (() => {
      try {
        op.fail('too late', clock.now());
        return undefined;
      } catch (error) {
        return error;
      }
    })();

    expect(kindOf(thrown)).toBe(Kind.Conflict);
    expect(op.state).toBe(OperationState.Succeeded);
  });

  it('refuses a success after a cancellation', () => {
    // The worker finished, and the caller had already been told it would not.
    const op = started();
    op.cancel(clock.now());

    expect(() => {
      op.succeed({ href: '/v1/x' }, clock.now());
    }).toThrow();
    expect(op.state).toBe(OperationState.Cancelled);
  });

  it('keeps the result a poll already saw, byte for byte', () => {
    const op = started();
    op.succeed({ href: '/v1/x', size: 42 }, clock.now());

    const first = op.toState();
    try {
      op.fail('nope', clock.now());
    } catch {
      /* expected */
    }

    expect(op.toState()).toEqual(first);
  });
});

describe('cancellation is a state, not a kill', () => {
  it('is idempotent, because a client pressing twice is a client', () => {
    const op = started();

    expect(op.cancel(clock.now()).changed).toBe(true);
    expect(op.cancel(clock.now()).changed).toBe(false);
  });

  it('refuses to cancel something that already succeeded', () => {
    // The artifact exists. Pretending it does not is worse than saying no.
    const op = started();
    op.succeed({ href: '/v1/x' }, clock.now());

    expect(() => {
      op.cancel(clock.now());
    }).toThrow();
  });

  it('tells a worker to stop at its next checkpoint, and nothing more', () => {
    // The whole of what cancellation can mean to work already running. A
    // module promising to interrupt would be promising what no queue and no
    // filesystem can deliver.
    const op = started();
    expect(op.abandoned).toBe(false);

    op.cancel(clock.now());

    expect(op.abandoned).toBe(true);
  });
});

describe('terminality', () => {
  it.each([
    [OperationState.Running, false],
    [OperationState.Succeeded, true],
    [OperationState.Failed, true],
    [OperationState.Cancelled, true],
  ])('%s is terminal: %s', (state, expected) => {
    expect(isTerminal(state)).toBe(expected);
  });
});

describe('the store', () => {
  it('round-trips a settled operation', async () => {
    const store = memoryOperationStore();
    const operations = memoryOperations(store);
    const op = started();

    await operations.create(op);
    op.succeed({ href: '/v1/x', size: 3 }, clock.now());
    await operations.save(op);

    const found = await operations.byId('op-1');
    expect(found?.state).toBe(OperationState.Succeeded);
    expect(found?.result?.size).toBe(3);
  });

  it('refuses a write on a stale version', async () => {
    const store = memoryOperationStore();
    const operations = memoryOperations(store);
    const op = started();
    await operations.create(op);

    const first = await operations.byId('op-1');
    const second = await operations.byId('op-1');
    first?.succeed({ href: '/v1/a' }, clock.now());
    await operations.save(first ?? op);

    second?.fail('nope', clock.now());
    await expect(operations.save(second ?? op)).rejects.toThrow();
  });

  it('is undefined for an id nobody started', async () => {
    await expect(
      memoryOperations(memoryOperationStore()).byId('nope'),
    ).resolves.toBeUndefined();
    void seconds;
  });
});
