/**
 * Where operations live. **A port, two adapters, one contract suite** — `I2`.
 */

import { type Operation } from './operation.js';

export interface Operations {
  byId(id: string): Promise<Operation | undefined>;
  /**
   * Create. **Takes the caller's writer**, so the operation row and whatever it
   * is about commit together — the same reason `work.enqueue` does.
   */
  create(operation: Operation, writer?: unknown): Promise<void>;
  /** Writes on `(id, baseVersion)`. A mismatch raises `Conflict`. */
  save(operation: Operation, writer?: unknown): Promise<void>;
}
