import { describe } from 'vitest';
import { fakeClock } from '../../../../shared/clock/index.js';
import { fakeIds } from '../../../../shared/id/index.js';
import { memoryEvents } from '../../../../shared/events/index.js';
import { identityStoreContract } from '../../app/ports.contract.js';
import { memoryReaders, memoryStore, memoryTransactor } from './index.js';

describe('memory adapter', () => {
  identityStoreContract(() => {
    // A fresh store per case. Sharing one would make the unique-address case
    // depend on which order the cases ran in.
    const clock = fakeClock();
    const store = memoryStore();
    const publisher = memoryEvents({ clock, ids: fakeIds(clock) });

    return {
      name: 'memory',
      transactor: memoryTransactor({ store, publisher }),
      read: () => memoryReaders(store),
    };
  });
});
