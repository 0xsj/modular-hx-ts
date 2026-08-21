import { randomBytes } from 'node:crypto';

export const jitter = (): number => Math.random();
export const nonce = (): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(16));
export const token = (): string => randomBytes(32).toString('hex');
