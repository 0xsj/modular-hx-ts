import type { Clock } from '../clock/index.js';

// The monotonic reading, per M13.
export const waited = (clock: Clock, startedAt: number): number =>
  clock.elapsed() - startedAt;
