import { classify, Level } from '../../../../shared/classification/index.js';

interface User {
  id: string;
  email: string;
  passwordHash: string;
}

// Defeats the exhaustive record: `passwordHash` is unclassified and the
// assertion hides it. This is what M9 detects, because the type system cannot.
export const USER = classify<User>('identity.User', {
  id: Level.Internal,
  email: Level.Pii,
} as Record<keyof User, Level>);
