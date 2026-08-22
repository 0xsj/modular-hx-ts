import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { fakeClock } from '../clock/index.js';
import { isAppError, Kind } from '../errors/index.js';
import { fakeIds } from '../id/index.js';
import { Carrier } from './carrier.js';
import { makeOrigins } from './origins.js';
import { type Provenance } from './provenance.js';

const origins = makeOrigins(fakeIds(fakeClock()));
const request = (correlationId: string): Provenance =>
  origins.forRequest({ correlationId });

describe('current', () => {
  it('is undefined outside any scope, and never throws', () => {
    // `logger` is the caller that matters: a log line must never crash, least
    // of all the one being written while something else is already wrong.
    expect(() => Carrier.current()).not.toThrow();
    expect(Carrier.current()).toBeUndefined();
  });

  it('is the provenance in scope', () => {
    const p = request('corr_1');

    Carrier.run(p, () => {
      expect(Carrier.current()?.correlationId).toBe('corr_1');
    });
  });

  it('is undefined again once the scope ends', () => {
    Carrier.run(request('corr_1'), () => undefined);

    expect(Carrier.current()).toBeUndefined();
  });
});

describe('require', () => {
  it('returns the provenance in scope', () => {
    Carrier.run(request('corr_1'), () => {
      expect(Carrier.require().correlationId).toBe('corr_1');
    });
  });

  it('raises Internal outside a scope, because that is a bug', () => {
    // A stamp point with no provenance is a programmer error, not user input.
    let thrown: unknown;
    try {
      Carrier.require();
    } catch (error) {
      thrown = error;
    }

    expect(isAppError(thrown)).toBe(true);
    expect(isAppError(thrown) && thrown.kind).toBe(Kind.Internal);
    expect(isAppError(thrown) && thrown.message).toBe('no provenance in scope');
  });
});

describe('the scope follows the async chain', () => {
  it('survives await', async () => {
    await Carrier.run(request('corr_1'), async () => {
      await delay(1);
      expect(Carrier.current()?.correlationId).toBe('corr_1');
    });
  });

  it('survives a timer and a microtask', async () => {
    await Carrier.run(request('corr_1'), async () => {
      await Promise.resolve();
      await delay(0);
      await Promise.all([delay(1), delay(2)]);

      expect(Carrier.current()?.correlationId).toBe('corr_1');
    });
  });

  it('survives a rejection being caught', async () => {
    await Carrier.run(request('corr_1'), async () => {
      await Promise.reject(new Error('boom')).catch(() => undefined);

      expect(Carrier.current()?.correlationId).toBe('corr_1');
    });
  });
});

describe('isolation', () => {
  it('keeps concurrent requests apart', async () => {
    // The property the whole mechanism depends on. If two in-flight requests
    // could see each other's provenance, every audit record would be suspect
    // and the bug would only appear under load.
    const seen = await Promise.all(
      ['corr_a', 'corr_b', 'corr_c'].map(async (correlationId, index) =>
        Carrier.run(request(correlationId), async () => {
          // Interleave deliberately: the later requests finish first.
          await delay(5 - index * 2);
          return Carrier.current()?.correlationId;
        }),
      ),
    );

    expect(seen).toEqual(['corr_a', 'corr_b', 'corr_c']);
  });

  it('nests, with the inner scope winning and the outer restored', () => {
    Carrier.run(request('outer'), () => {
      Carrier.run(request('inner'), () => {
        expect(Carrier.current()?.correlationId).toBe('inner');
      });

      expect(Carrier.current()?.correlationId).toBe('outer');
    });
  });

  it('does not leak out of a callback that threw', () => {
    expect(() =>
      Carrier.run(request('corr_1'), () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(Carrier.current()).toBeUndefined();
  });
});

describe('run', () => {
  it('returns whatever the callback returns', () => {
    expect(Carrier.run(request('corr_1'), () => 42)).toBe(42);
  });

  it('returns the promise from an async callback', async () => {
    await expect(
      Carrier.run(request('corr_1'), async () => {
        await delay(1);
        return 'done';
      }),
    ).resolves.toBe('done');
  });
});
