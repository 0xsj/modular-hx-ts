/**
 * How a `LogRecord` becomes text. **L1 runtime.**
 *
 * Two audiences, two formats, and no dependency for either.
 *
 * - **Console** is for a person reading a terminal: aligned, colourised, values
 *   after the message so the messages line up and scan vertically.
 * - **JSON** is for a machine: one object per line, flat keys, no colour.
 *
 * Colour is a **parameter, not an inspection**. Detecting a TTY inside the
 * formatter would make its output depend on where the test ran, and the
 * decision is configuration — which `env` owns when it lands.
 *
 * See `notes/patterns/logger.md`.
 */

import { isAppError } from '../errors/index.js';
import { type Level, type LogRecord } from './record.js';

// --- colour ----------------------------------------------------------------

const ESC = '\u001b[';
const RESET = `${ESC}0m`;

const CODE = {
  dim: `${ESC}2m`,
  gray: `${ESC}90m`,
  cyan: `${ESC}36m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  red: `${ESC}31m`,
} as const;

type Colour = keyof typeof CODE;

const LEVEL_COLOUR: Readonly<Record<Level, Colour>> = {
  trace: 'gray',
  debug: 'cyan',
  info: 'green',
  warn: 'yellow',
  error: 'red',
};

const paint = (colour: Colour, text: string, enabled: boolean): string =>
  enabled ? `${CODE[colour]}${text}${RESET}` : text;

// --- values ----------------------------------------------------------------

/**
 * An error, as a plain object.
 *
 * Only reached by a **second** error on the same call: the first is promoted to
 * `error` and `err_kind` before formatting. The cause chain is flattened to
 * messages rather than nested objects, because a log line is read, and
 * `load user: query user by id: connection refused` reads.
 */
function describeError(error: Error): Record<string, unknown> {
  const causes: string[] = [];
  let current: unknown = error.cause;
  while (current instanceof Error && causes.length < 8) {
    causes.push(current.message);
    current = current.cause;
  }

  return {
    message: error.message,
    ...(isAppError(error) ? { kind: error.kind } : { name: error.name }),
    ...(causes.length === 0 ? {} : { causes }),
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

/**
 * `JSON.stringify` that cannot throw.
 *
 * It throws on a cycle, and a log call turning into an exception — at the
 * moment something else is already going wrong — is worse than a lossy line.
 * `redactKeys` has usually replaced cycles by the time a record gets here, but
 * a formatter that only works downstream of one specific caller is a trap.
 *
 * Only ever called with an object: `undefined`, functions and symbols are the
 * inputs that make `stringify` return `undefined`, and each is handled before
 * this point.
 */
function safely(value: object): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[circular]';
  }
}

/** A value, as JSON would carry it. */
function forJson(value: unknown): unknown {
  if (value instanceof Error) return describeError(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Quote only when the value would otherwise be ambiguous.
 *
 * `email=ada@example.com` is easier to read than `email="ada@example.com"`, and
 * an unquoted value containing a space would silently look like two fields.
 */
function quoteIfNeeded(value: string): string {
  return /[\s"=]/.test(value) || value === '' ? JSON.stringify(value) : value;
}

/** A value, compactly, for a person. */
function forConsole(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (value instanceof Error) {
    const kind = isAppError(value) ? `${value.kind}: ` : '';
    return quoteIfNeeded(`${kind}${value.message}`);
  }
  if (value instanceof Date) return value.toISOString();

  switch (typeof value) {
    case 'string':
      return quoteIfNeeded(value);
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'function':
      return '[function]';
    case 'symbol':
      return value.toString();
    default:
      return safely(value);
  }
}

// --- console ---------------------------------------------------------------

const clockPart = (at: Date): string => at.toISOString().slice(11, 23);

/** Longest level name, so messages align down the page. */
const LEVEL_WIDTH = 5;

const indent = (block: string): string =>
  block
    .split('\n')
    .map((row) => `    ${row.trim()}`)
    .join('\n');

/**
 * One line, plus a stack on its own lines when there is one.
 *
 * The stack goes last and dimmed: it matters when it matters, and it must not
 * push the fields off the screen the other ninety-nine times.
 */
export function formatConsole(record: LogRecord, colour = false): string {
  const level = record.level.toUpperCase().padEnd(LEVEL_WIDTH);

  const head = [
    paint('dim', clockPart(record.time), colour),
    paint(LEVEL_COLOUR[record.level], level, colour),
    record.msg,
  ].join(' ');

  const stacks: string[] = [];
  if (record.thrown?.stack !== undefined) stacks.push(record.thrown.stack);

  const pairs = Object.entries(record.fields).map(([key, value]) => {
    if (value instanceof Error && value.stack !== undefined) {
      stacks.push(value.stack);
    }
    return `${paint('dim', `${key}=`, colour)}${forConsole(value)}`;
  });

  const line = pairs.length === 0 ? head : `${head}  ${pairs.join(' ')}`;

  return stacks.length === 0
    ? line
    : [
        line,
        ...stacks.map((stack) => paint('dim', indent(stack), colour)),
      ].join('\n');
}

// --- json ------------------------------------------------------------------

/**
 * One object per line.
 *
 * Fields are flattened alongside `time`, `level` and `msg` rather than nested
 * under a `fields` key, because every log pipeline filters on top-level keys.
 * The record's own three are written last, so a field called `level` cannot
 * shadow the level.
 *
 * The stack is deliberately absent: `error` and `err_kind` carry what a query
 * needs, and a stack in a JSON field is a wall of text in every log viewer.
 */
export function formatJson(record: LogRecord): string {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.fields)) {
    fields[key] = forJson(value);
  }

  return safely({
    ...fields,
    time: record.time.toISOString(),
    level: record.level,
    msg: record.msg,
  });
}
