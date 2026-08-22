/**
 * Structured logging. **L1 runtime.**
 *
 * Three implementations of one port, as `../../../MODULES.md` specifies:
 * console, JSON, memory. All three share the level filtering, bound fields,
 * ambient provenance and redaction in `logger.ts` — they differ only in what
 * happens to a finished record.
 *
 * **The baseline has no dependencies.** `consoleLogger` formats and colourises
 * by hand, in about a hundred lines. If a library ever earns its place it
 * becomes a fourth implementation behind this same port, and rule `S10`
 * confines it to this module — nothing else would change.
 *
 * Specification: `../../../MODULES.md` L1. Note: `notes/patterns/logger.md`.
 */

import { type Clock } from '../clock/index.js';
import { formatConsole, formatJson } from './format.js';
import { makeLogger, type Logger, type Sink } from './logger.js';
import { type Fields, type Level, type LogRecord } from './record.js';

export { Level, type Fields, type LogRecord, LEVELS, meets } from './record.js';
export { type Logger, type Sink, type LoggerOptions } from './logger.js';
export { formatConsole, formatJson } from './format.js';

/** Where lines go. Injected so a test never writes to a real stream. */
export type Write = (line: string) => void;

const toStdout: Write = (line) => {
  process.stdout.write(`${line}\n`);
};

export interface ConsoleOptions {
  readonly clock: Clock;
  readonly level?: Level;
  readonly bound?: Fields;
  /**
   * ANSI colour. A parameter rather than an inspection, so output does not
   * depend on where the process happens to be running. Use `detectColour()` at
   * the composition root.
   */
  readonly colour?: boolean;
  readonly write?: Write;
}

/**
 * Human-readable, colourised, aligned.
 *
 * The development default, and the reason the baseline needs no library.
 */
export function consoleLogger(options: ConsoleOptions): Logger {
  const write = options.write ?? toStdout;
  const sink: Sink = (record) => {
    write(formatConsole(record, options.colour ?? false));
  };

  return makeLogger({
    clock: options.clock,
    sink,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.bound === undefined ? {} : { bound: options.bound }),
  });
}

export interface JsonOptions {
  readonly clock: Clock;
  readonly level?: Level;
  readonly bound?: Fields;
  readonly write?: Write;
}

/**
 * One JSON object per line.
 *
 * The production default: every log pipeline parses this, and nothing has to
 * guess where a field ends.
 */
export function jsonLogger(options: JsonOptions): Logger {
  const write = options.write ?? toStdout;
  const sink: Sink = (record) => {
    write(formatJson(record));
  };

  return makeLogger({
    clock: options.clock,
    sink,
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.bound === undefined ? {} : { bound: options.bound }),
  });
}

export interface MemoryLogger extends Logger {
  /** Every record captured, in order, including from children. */
  records(): readonly LogRecord[];
  /** The formatted lines, for the rare test that is about formatting. */
  lines(): readonly string[];
  clear(): void;
}

export interface MemoryOptions {
  readonly clock: Clock;
  readonly level?: Level;
  readonly bound?: Fields;
}

/**
 * Captures records instead of writing them.
 *
 * A test asserts on **fields**, not on a formatted string — which is the
 * difference between a test that survives a formatting change and one that
 * breaks when somebody adds a space. `lines()` exists for the few tests that
 * genuinely are about the format.
 *
 * Children share the parent's buffer, so a test sees everything one component
 * logged regardless of how it subdivided its logger.
 */
export function memoryLogger(options: MemoryOptions): MemoryLogger {
  const captured: LogRecord[] = [];

  const base = makeLogger({
    clock: options.clock,
    sink: (record) => {
      captured.push(record);
    },
    ...(options.level === undefined ? {} : { level: options.level }),
    ...(options.bound === undefined ? {} : { bound: options.bound }),
  });

  return {
    ...base,
    child: (fields) => base.child(fields),
    records: () => captured,
    lines: () => captured.map((record) => formatConsole(record)),
    clear: () => {
      captured.length = 0;
    },
  };
}

/**
 * Whether this process should colourise.
 *
 * Honours `NO_COLOR` and `FORCE_COLOR`, then falls back to whether stdout is a
 * terminal. Lives here for now and belongs to `env` once that lands — which is
 * why nothing in the module calls it: the composition root does, and passes the
 * answer in.
 */
export function detectColour(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  // `@types/node` declares `isTTY` as `boolean`, and at runtime the property
  // is simply absent when stdout is a pipe — so this can return `undefined`
  // from something typed `boolean`. Harmless everywhere it is used: callers
  // pass the result to `colour?: boolean`, where absent and false coincide.
  return process.stdout.isTTY;
}
