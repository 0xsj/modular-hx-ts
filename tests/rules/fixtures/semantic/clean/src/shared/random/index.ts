// The one module permitted to touch a source of entropy.
export const systemRandom = () => ({
  bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
});

import { timingSafeEqual } from 'node:crypto';
export const equal = (a: Buffer, b: Buffer): boolean => timingSafeEqual(a, b);
