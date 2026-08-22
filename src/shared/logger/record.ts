/**
 * What a log line is, before anyone decides how it looks. **L1 runtime.**
 *
 * The three implementations — console, JSON, memory — differ only in what they
 * do with a `LogRecord`. Keeping the record separate from its rendering is what
 * lets a test assert on *fields* rather than on a formatted string, which is
 * the difference between a test that survives a formatting change and one that
 * does not.
 *
 * See `notes/patterns/logger.md`.
 */

export const Level = {
  /** Loop-level detail. Off everywhere but a debugging session. */
  Trace: 'trace',
  /** Useful when something is wrong and you are looking. */
  Debug: 'debug',
  /** The default. A thing happened that someone might ask about later. */
  Info: 'info',
  /** Degraded, handled, and worth noticing — a retry, a fallback, a breaker. */
  Warn: 'warn',
  /** Something failed that nobody planned for. */
  Error: 'error',
} as const;

export type Level = (typeof Level)[keyof typeof Level];

/**
 * Severity, as a number, so a minimum level is a comparison.
 *
 * Gaps of ten on purpose: a level inserted later does not renumber the others,
 * and nothing persists these values anyway.
 */
const SEVERITY: Readonly<Record<Level, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export const LEVELS: readonly Level[] = Object.values(Level);

/** Whether `level` should be emitted when the minimum is `minimum`. */
export function meets(level: Level, minimum: Level): boolean {
  return SEVERITY[level] >= SEVERITY[minimum];
}

/**
 * Structured context on a line.
 *
 * `unknown`, not `string`: a log call should never have to stringify its own
 * values, because that is how a value gets formatted one way here and another
 * way three files over.
 */
export type Fields = Readonly<Record<string, unknown>>;

/**
 * A record, in the shape `../../../MODULES.md` §2 specifies.
 *
 * `time`, `level` and `msg` are the three every adapter always emits, and the
 * names are normative — conformance case 54 checks them byte-identically across
 * every blueprint, because if one emits `err_kind` and another `error_kind`,
 * both repos' own suites pass and the collection has silently drifted.
 */
export interface LogRecord {
  /** From the injected clock. Rule `M2` — nothing here reads the wall clock. */
  readonly time: Date;
  readonly level: Level;
  readonly msg: string;
  /**
   * Provenance, the promoted error fields, then bound and call fields. Already
   * redacted, and absent values are omitted rather than written empty.
   */
  readonly fields: Fields;
  /**
   * The error itself, when one was logged — kept aside so the console adapter
   * can render a stack. Never a field: `error` and `err_kind` carry it.
   */
  readonly thrown?: Error;
}
