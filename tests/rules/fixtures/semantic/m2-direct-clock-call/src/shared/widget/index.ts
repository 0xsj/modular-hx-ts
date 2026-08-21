export const stamp = (): Date => new Date();
export const elapsed = (since: number): number => Date.now() - since;
export const latency = (since: number): number => performance.now() - since;
