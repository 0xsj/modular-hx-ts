/**
 * Turning a schema and a source into typed configuration. **L1 runtime.**
 *
 * The whole point is in one behaviour: **every problem is reported at once.**
 * `../../../MODULES.md` says so, and the reason is the person on the other end
 * of it. Failing on the first bad variable means fix, redeploy, fail, fix,
 * redeploy — once per mistake, each cycle costing whatever a deploy costs. A
 * misconfigured service should tell you everything that is wrong in one go.
 *
 * See `notes/patterns/env.md`.
 */

import { invalid, type AppError } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { type Problem, type Reader } from './readers.js';
import { type Source } from './source.js';

/** A component's configuration, as a set of named readers. */
export type Schema = Readonly<Record<string, Reader<unknown>>>;

/** The typed shape a schema produces. */
export type Config<S extends Schema> = {
  readonly [K in keyof S]: S[K] extends Reader<infer T> ? T : never;
};

/**
 * Read a schema, collecting every problem.
 *
 * The failure is a single `Invalid` error whose `fields` carry one entry per
 * bad variable — reusing the shape `errors` already has for exactly this, so a
 * configuration failure and a rejected request body report the same way.
 */
export function load<S extends Schema>(
  source: Source,
  schema: S,
): Result<Config<S>> {
  const values: Record<string, unknown> = {};
  const problems: Problem[] = [];

  for (const [key, reader] of Object.entries(schema)) {
    const outcome = reader.read(source.get(reader.variable));

    if ('problem' in outcome) {
      problems.push({ variable: reader.variable, message: outcome.problem });
      continue;
    }
    values[key] = outcome.value;
  }

  if (problems.length > 0) return err(report(problems));

  return ok(values as Config<S>);
}

/**
 * One error naming every problem.
 *
 * The message is a count and the detail is in `fields`, so a log line stays one
 * line and the specifics are still structured enough to render as a list.
 */
function report(problems: readonly Problem[]): AppError {
  const summary =
    problems.length === 1
      ? '1 configuration problem'
      : `${String(problems.length)} configuration problems`;

  return invalid(
    summary,
    problems.map((problem) => ({
      field: problem.variable,
      message: problem.message,
    })),
  );
}

/**
 * Human-readable lines for a startup failure.
 *
 * A process that will not start should say why on the way out, in a form
 * somebody can act on without a log aggregator:
 *
 *     2 configuration problems
 *       PORT       is not a whole number: 80a0
 *       SMTP_HOST  is required
 */
export function explain(error: AppError): string {
  const width = Math.max(0, ...error.fields.map((field) => field.field.length));

  return [
    error.message,
    ...error.fields.map(
      (field) => `  ${field.field.padEnd(width)}  ${field.message}`,
    ),
  ].join('\n');
}

/**
 * What is set, without saying what any of it is.
 *
 * For a startup diagnostic: names, and whether each has a value. Sensitive
 * readers report `set` or `unset` and never their contents — the listing exists
 * to answer "did the deploy pick up my change", which needs no secrets.
 */
export function describe(source: Source, schema: Schema): readonly string[] {
  return Object.values(schema).map((reader) => {
    const raw = source.get(reader.variable);
    const state =
      raw === undefined || raw.trim() === ''
        ? 'unset'
        : reader.sensitive
          ? 'set'
          : raw;

    return `${reader.variable}=${state}`;
  });
}
