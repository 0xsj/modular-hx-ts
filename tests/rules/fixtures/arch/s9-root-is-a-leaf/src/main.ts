// The root importing the root. **Legal**, and the reason S9's `from` excludes
// the root's own files: `main.ts` is the process — argument parsing, signals,
// exit codes — and `wire.ts` is the assembly. A rule that forbade this edge
// would make a one-file composition root mandatory.
import { container } from './wire.js';

export const app = container;
