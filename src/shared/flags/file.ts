/**
 * Polled JSON. **The `file` provider.**
 *
 * Changed without a deploy, and without a database — a mounted ConfigMap, a
 * file an operator edits. Between `static` and `postgres` in both directions:
 * it can change at runtime, and it is per-instance rather than fleet-wide.
 *
 * Serves stale for the same reason `postgres` does, and by the same mechanism:
 * `get` never touches the filesystem.
 *
 * See `notes/patterns/flags.md`.
 */

import { type Clock, type Millis, seconds, since } from '../clock/index.js';
import { validate, type Flag } from './rule.js';
import { type Source } from './port.js';

/** The one filesystem call this needs, injectable so a test never touches disk. */
export type ReadFile = () => Promise<string>;

export interface FileOptions {
  readonly read: ReadFile;
  readonly clock: Clock;
  readonly ttl?: Millis;
  readonly onError?: (error: unknown) => void;
}

export interface FileSource extends Source {
  /** Required here, though optional on `Source` — `static` has nothing to do. */
  start(): Promise<void>;
  stop(): Promise<void>;
  refresh(): Promise<void>;
}

export function fileSource(options: FileOptions): FileSource {
  const { read, clock } = options;
  const ttl = options.ttl ?? seconds(10);

  let cache = new Map<string, Flag>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;

  const load = async (): Promise<void> => {
    const raw = await read();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      options.onError?.(new Error('flags file is not an array'));
      return;
    }

    const checked = validate(parsed as Flag[]);
    if (!checked.ok) {
      // Keep serving the last good set. A malformed edit must not turn every
      // flag off — which is the failure mode that makes people stop trusting
      // the file provider.
      options.onError?.(checked.error);
      return;
    }

    cache = new Map(checked.value.map((f) => [f.key, f]));
    loadedAt = clock.elapsed();
  };

  const refreshInBackground = (): void => {
    if (inFlight !== undefined) return;
    inFlight = load()
      .catch((error: unknown) => {
        options.onError?.(error);
      })
      .finally(() => {
        inFlight = undefined;
      });
  };

  return {
    get(key) {
      if (since(clock, loadedAt) >= ttl) refreshInBackground();
      return cache.get(key);
    },
    all() {
      if (since(clock, loadedAt) >= ttl) refreshInBackground();
      return [...cache.values()];
    },
    async start() {
      await load();
    },
    async stop() {
      await inFlight;
    },
    async refresh() {
      await load();
    },
  };
}
