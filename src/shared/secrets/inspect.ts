/**
 * The check command's engine. **L1 runtime.**
 *
 * `../../../MODULES.md` §2: *ships with a check command — prints each
 * reference, its source, and a will-it-boot exit code, **without printing a
 * value**. It is the difference between diagnosing a deployment in one command
 * and diagnosing it by restarting.*
 *
 * The restart loop is the thing being replaced. A broken secret reference
 * surfaces as a process that exits 78 with one line, then exits 78 again with
 * the next line after that one is fixed — one variable per restart, against a
 * deployment that is already down.
 *
 * **It resolves through `resolving`, not beside it.** A check that exercised
 * its own copy of the resolution path would diagnose a different program, and
 * would agree with boot right up until the moment it mattered.
 *
 * See `notes/patterns/secrets.md`.
 */

import { type Source } from '../env/index.js';
import { type FileSystem, nodeFileSystem } from './filesystem.js';
import { describe, literal, parse } from './reference.js';
import { resolving } from './resolve.js';

/**
 * Where a variable's value comes from.
 *
 * `unset` is reported rather than omitted: a variable with a fallback is fine
 * and one without is not, and only the schema knows which — so this states the
 * fact and leaves the judgement to `env`.
 */
export type Origin = 'file' | 'env' | 'literal' | 'inline' | 'unset';

export interface Inspection {
  readonly variable: string;
  readonly origin: Origin;
  /** The reference as written — `file:///run/secrets/smtp#password`. */
  readonly reference?: string;
  /** Whether it resolved. An `unset` or inline value trivially does. */
  readonly ok: boolean;
  /** Why it did not. Names the variable and the cause, **never the value**. */
  readonly problem?: string;
}

/**
 * Resolve every named variable and report what happened to it.
 *
 * No value is returned, anywhere, by construction: the only strings that leave
 * here are variable names, reference targets and failure reasons.
 */
export function inspect(
  source: Source,
  variables: readonly string[],
  filesystem: FileSystem = nodeFileSystem(),
): readonly Inspection[] {
  const resolved = resolving(source, filesystem);

  return variables.map((variable): Inspection => {
    const raw = source.get(variable);

    if (raw === undefined || raw.trim() === '') {
      return { variable, origin: 'unset', ok: true };
    }

    // Checked first, exactly as `resolving` checks it first.
    if (literal(raw) !== undefined) {
      return { variable, origin: 'literal', ok: true };
    }

    const reference = parse(raw);
    if (reference === undefined) {
      return { variable, origin: 'inline', ok: true };
    }

    // Problems accumulate on the shared resolver, so the slice taken here is
    // this variable's own.
    const before = resolved.problems().length;
    const value = resolved.source.get(variable);
    const [problem] = resolved.problems().slice(before);

    if (problem !== undefined) {
      return {
        variable,
        origin: reference.scheme,
        reference: describe(reference),
        ok: false,
        problem: problem.message,
      };
    }

    return {
      variable,
      origin: reference.scheme,
      reference: describe(reference),
      // A reference that resolved to nothing without recording a problem
      // should be impossible; reporting it as broken is the safe direction.
      ok: value !== undefined,
      ...(value === undefined ? { problem: 'resolved to nothing' } : {}),
    };
  });
}

/** Whether this configuration will boot. The check command's exit code. */
export function willBoot(inspections: readonly Inspection[]): boolean {
  return inspections.every((inspection) => inspection.ok);
}

/**
 * The report, as text.
 *
 * Aligned so a column of `ok` is scannable and a `FAILED` is not. Rendering
 * lives here rather than in the composition root because the guarantee that no
 * value is printed is this module's to keep.
 */
export function report(inspections: readonly Inspection[]): string {
  const width = Math.max(0, ...inspections.map((i) => i.variable.length));
  const shown = (inspection: Inspection): string =>
    inspection.reference ?? inspection.origin;
  // Capped: one long mount path would otherwise pad every other line off the
  // right of the terminal, and the column exists to be scannable.
  const column = Math.min(
    48,
    Math.max(0, ...inspections.map((i) => shown(i).length)),
  );

  const lines = inspections.map((inspection) => {
    const verdict = inspection.ok
      ? 'ok'
      : `FAILED  ${inspection.problem ?? 'unresolved'}`;
    return `  ${inspection.variable.padEnd(width)}  ${shown(inspection).padEnd(column)}  ${verdict}`;
  });

  const broken = inspections.filter((inspection) => !inspection.ok).length;
  const verdict =
    broken === 0
      ? 'every reference resolved — this configuration boots'
      : `${String(broken)} unresolved — this configuration will not boot`;

  return [...lines, '', verdict].join('\n');
}
