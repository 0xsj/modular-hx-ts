/**
 * The logging port. **L1 runtime.**
 *
 * One implementation shape, three sinks: console for a person, JSON for a
 * machine, memory for a test. Everything below the sink — level filtering,
 * bound fields, provenance, redaction — happens once, here, so the three
 * cannot drift apart.
 *
 * **The record shape is specified**, not a local choice — `../../../MODULES.md`
 * §2 fixes the field names because five repos built a logger and none emitted
 * the error's `Kind`. A line carrying `err_kind=unavailable` is queryable in a
 * way `msg="upstream failed"` never is, and it joins to the RFC 9457 status the
 * edge produced from the same value.
 *
 * Three decisions worth knowing before reading:
 *
 * - **Provenance is pulled ambiently.** `PROVENANCE.md` §3 names `logger` as
 *   one of exactly three consumers permitted to, because threading it through
 *   every log call would be noise and because this one cannot forget.
 * - **Fields are redacted.** A whole request body handed to a logger is how a
 *   bearer token reaches disk, and `redact` exists for precisely this.
 * - **A log line never throws.** Not the formatter, not the sink. An
 *   observability failure must not become an outage, and the line most likely
 *   to break is the one being written while something else already has.
 *
 * See `notes/patterns/logger.md`.
 */

import { type Clock } from '../clock/index.js';
import { kindOf } from '../errors/index.js';
import { Carrier } from '../provenance/index.js';
import { redactKeys } from '../redact/index.js';
import { type Fields, type Level, type LogRecord, meets } from './record.js';

export interface Logger {
  trace(message: string, fields?: Fields): void;
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;

  /**
   * A logger that adds these fields to every line.
   *
   * For a component that has context worth repeating — a worker's queue name, a
   * subscriber's event type. Cheaper and harder to forget than passing the same
   * fields to every call.
   */
  child(fields: Fields): Logger;

  /**
   * Whether a level would be emitted.
   *
   * For the case where building the fields is itself expensive: `if
   * (log.enabled('debug')) log.debug('...', expensive())`.
   */
  enabled(level: Level): boolean;
}

/** Where a formatted record goes. */
export type Sink = (record: LogRecord) => void;

export interface LoggerOptions {
  /** Injected: rule `M2` forbids this module reading the wall clock. */
  readonly clock: Clock;
  readonly sink: Sink;
  /** Lines below this are dropped before any work is done. */
  readonly level?: Level;
  /** Fields added to every line from this logger. */
  readonly bound?: Fields;
}

/**
 * Provenance as flat log fields.
 *
 * `PROVENANCE.md` §7 splits two audiences: the **of-record** subset is hashed
 * and signed, and the **observability** subset is for logs and spans. This is
 * the second one, so the actor is its compact `user:01a0…` string rather than
 * the nested object — a log pipeline filters on flat keys, and a person reads a
 * line.
 *
 * Returns nothing at all when there is no provenance in scope. `current()`
 * never throws, which is why `logger` is allowed to call it.
 */
function provenanceFields(): Fields {
  const provenance = Carrier.current();
  if (provenance === undefined) return {};

  const actor = provenance.actor;

  return {
    request_id: provenance.requestId,
    correlation_id: provenance.correlationId,
    ...(provenance.causationId === undefined
      ? {}
      : { causation_id: provenance.causationId }),
    actor: String(actor),
    ...(actor.onBehalfOf === undefined
      ? {}
      : { on_behalf_of: String(actor.onBehalfOf) }),
    ...(provenance.tenant === undefined ? {} : { tenant: provenance.tenant }),
    ...traceFields(provenance.traceparent),
  };
}

/**
 * `trace_id`, derived from the traceparent.
 *
 * The W3C header is `version-traceid-parentid-flags`; only the trace id belongs
 * on a log line, because that is what correlates records to a trace.
 *
 * **It comes from provenance, never from `telemetry`.** That is exactly why
 * `traceparent` is a plain string on provenance rather than a typed span
 * context: `logger` and `telemetry` are both L1, so an import between them
 * would be a sideways dependency for a value that is already here.
 */
function traceFields(traceparent: string | undefined): Fields {
  if (traceparent === undefined) return {};

  const traceId = traceparent.split('-')[1];
  return traceId === undefined ? {} : { trace_id: traceId };
}

/**
 * `error` and `err_kind`, lifted out of whatever the caller named the field.
 *
 * The taxonomy is the point. A free-form message is greppable; a `Kind` is
 * queryable, and it is the same value the edge maps to a status — so an alert
 * on `err_kind=unavailable` and a 503 rate are the same question asked twice.
 *
 * The first Error among the fields wins, and its own key is dropped: two names
 * for one failure on one line is how a dashboard ends up counting it twice.
 */
function errorFields(fields: Fields): {
  readonly promoted: Fields;
  readonly rest: Fields;
  readonly thrown: Error | undefined;
} {
  const rest: Record<string, unknown> = {};
  let thrown: Error | undefined;

  for (const [key, value] of Object.entries(fields)) {
    if (thrown === undefined && value instanceof Error) {
      thrown = value;
      continue;
    }
    rest[key] = value;
  }

  return {
    promoted:
      thrown === undefined
        ? {}
        : { error: thrown.message, err_kind: kindOf(thrown) },
    rest,
    thrown,
  };
}

export function makeLogger(options: LoggerOptions): Logger {
  const { clock, sink } = options;
  const minimum: Level = options.level ?? 'info';
  const bound: Fields = options.bound ?? {};

  const emit = (level: Level, message: string, fields?: Fields): void => {
    if (!meets(level, minimum)) return;

    // Provenance first, bound next, the call's own last — so a call site can
    // override a bound field, and nothing can quietly overwrite provenance
    // except deliberately.
    const { promoted, rest, thrown } = errorFields({ ...bound, ...fields });
    const merged = { ...provenanceFields(), ...promoted, ...rest };

    const record: LogRecord = {
      time: clock.now(),
      level,
      msg: message,
      fields: redactKeys(merged) as Fields,
      ...(thrown === undefined ? {} : { thrown }),
    };

    try {
      sink(record);
    } catch {
      // Deliberate, and the one place in this repository that swallows an
      // error. A logger that throws converts an observability failure — a
      // closed pipe, a full disk — into an outage. Invariant I9: availability
      // controls fail open.
    }
  };

  return {
    trace: (message, fields) => {
      emit('trace', message, fields);
    },
    debug: (message, fields) => {
      emit('debug', message, fields);
    },
    info: (message, fields) => {
      emit('info', message, fields);
    },
    warn: (message, fields) => {
      emit('warn', message, fields);
    },
    error: (message, fields) => {
      emit('error', message, fields);
    },

    child: (fields) =>
      makeLogger({ ...options, bound: { ...bound, ...fields } }),

    enabled: (level) => meets(level, minimum),
  };
}
