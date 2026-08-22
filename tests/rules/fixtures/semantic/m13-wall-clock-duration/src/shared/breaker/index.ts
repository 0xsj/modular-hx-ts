import type { Clock } from '../clock/index.js';

// A cooldown measured on the wall clock: an NTP correction breaks it.
export const cooled = (clock: Clock, openedAt: Date): boolean =>
  clock.now().getTime() - openedAt.getTime() > 5_000;
