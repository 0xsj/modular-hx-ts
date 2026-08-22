import { describe } from 'vitest';
import { fakeClock, type Clock } from '../clock/index.js';
import {
  consoleLogger,
  jsonLogger,
  memoryLogger,
  type MemoryLogger,
} from './index.js';
import {
  loggerContract,
  parseConsoleLine,
  type LoggerUnderTest,
} from './logger.contract.js';

/**
 * Every adapter runs the one suite (rule `M1`).
 *
 * They differ in format — a line for a person, an object for a collector, a
 * record for a test — and never in fields. Three near-identical suites would
 * pass happily while diverging; one suite cannot.
 */

const clock = (): Clock => fakeClock();

function consoleUnderTest(): LoggerUnderTest {
  const lines: string[] = [];

  return {
    name: 'console',
    build: (c) =>
      consoleLogger({
        clock: c,
        level: 'trace',
        colour: false,
        write: (line) => lines.push(line),
      }),
    emitted: () => lines.map(parseConsoleLine),
  };
}

function jsonUnderTest(): LoggerUnderTest {
  const lines: string[] = [];

  return {
    name: 'json',
    build: (c) =>
      jsonLogger({
        clock: c,
        level: 'trace',
        write: (line) => lines.push(line),
      }),
    emitted: () =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function memoryUnderTest(): LoggerUnderTest {
  let logger: MemoryLogger | undefined;

  return {
    name: 'memory',
    build: (c) => {
      logger = memoryLogger({ clock: c, level: 'trace' });
      return logger;
    },
    // The memory adapter keeps records rather than lines, so its field set is
    // the record's own three plus whatever was attached.
    emitted: () =>
      (logger?.records() ?? []).map((record) => ({
        time: record.time.toISOString(),
        level: record.level,
        msg: record.msg,
        ...record.fields,
      })),
  };
}

describe('console adapter', () => {
  loggerContract(consoleUnderTest, clock);
});

describe('json adapter', () => {
  loggerContract(jsonUnderTest, clock);
});

describe('memory adapter', () => {
  loggerContract(memoryUnderTest, clock);
});
