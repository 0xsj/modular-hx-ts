// The one module permitted to read the platform clock.
export const systemClock = () => ({ now: () => new Date() });
