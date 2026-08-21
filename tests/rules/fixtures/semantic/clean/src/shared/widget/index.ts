import type { Clock } from '../clock/index.js';

// Time arrives as a dependency.
export const stamp = (clock: Clock): Date => clock.now();

// Naming an instant is not reading one: deterministic, and allowed.
export const EPOCH = new Date('2026-01-01T00:00:00.000Z');
