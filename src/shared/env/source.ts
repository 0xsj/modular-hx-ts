/**
 * Where configuration values come from. **L1 runtime.**
 *
 * A one-method port, so a test never has to mutate `process.env` — which is
 * global, leaks between tests, and cannot be run in parallel.
 *
 * It is also the seam `secrets` needs. `../../../ARCHITECTURE.md` §8 requires
 * secret references — `file://`, `env://` — to be **resolved before
 * configuration is parsed**, and a source is exactly the thing to wrap:
 * `secrets.resolving(fromProcess())` returns another `Source`, and `env` never
 * learns that anything happened.
 *
 * See `notes/patterns/env.md`.
 */

export interface Source {
  /** The raw value, or nothing. Absent and empty are different. */
  get(name: string): string | undefined;

  /** Every name this source could supply, for diagnostics. */
  names(): readonly string[];
}

/**
 * The real environment.
 *
 * The one place in the repository that reads `process.env` for configuration.
 * `main.ts` reads a couple of variables directly today and stops once this is
 * wired in.
 */
export function fromProcess(): Source {
  return {
    get: (name) => process.env[name],
    names: () => Object.keys(process.env),
  };
}

/**
 * A fixed set of values, for tests and for defaults in `docker-compose`.
 *
 * An explicit `undefined` counts as absent, so a test can express "this
 * variable is not set" without deleting a key.
 */
export function fromRecord(
  values: Readonly<Record<string, string | undefined>>,
): Source {
  return {
    get: (name) => values[name],
    names: () =>
      Object.keys(values).filter((name) => values[name] !== undefined),
  };
}

/**
 * The first source that has a value wins.
 *
 * For layering an explicit override over the environment — a CLI flag, a test
 * fixture — without either side knowing about the other.
 */
export function layered(...sources: readonly Source[]): Source {
  return {
    get: (name) => {
      for (const source of sources) {
        const value = source.get(name);
        if (value !== undefined) return value;
      }
      return undefined;
    },
    names: () => [...new Set(sources.flatMap((source) => source.names()))],
  };
}
