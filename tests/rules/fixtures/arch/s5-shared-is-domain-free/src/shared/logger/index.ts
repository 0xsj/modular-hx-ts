import type { User } from '../../contexts/identity/domain/user.js'; // domain in the kernel
export const log = (u: User): string => u.id;
