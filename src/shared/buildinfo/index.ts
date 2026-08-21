/**
 * What this binary is. **L0 kernel** — pure, no I/O, no process state.
 *
 * Version, commit and build time, served at `/version` and stamped into logs
 * and outbound requests. The first question of every incident is "what is
 * actually deployed", and an answer that requires reading a CI log is not an
 * answer.
 *
 * **Nothing here reads `process.env`.** That is L1's job (`env`), and this
 * layer has no process state — the composition root passes the values in from
 * wherever the build put them. That is also what makes the formatting testable
 * without a build.
 *
 * See `notes/patterns/buildinfo.md`.
 */

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/;

export const UNKNOWN_VERSION = 'dev';
export const UNKNOWN_COMMIT = 'unknown';

export interface BuildInfo {
  /** The artifact's name, for a user agent and for logs. */
  readonly name: string;

  /** A semver string, or `dev` for an unstamped local build. */
  readonly version: string;

  /** A lowercase git sha, or `unknown`. */
  readonly commit: string;

  /** When the artifact was built. Absent when the stamp was missing or bad. */
  readonly builtAt?: Date;

  /** Built from a working tree with uncommitted changes. */
  readonly dirty: boolean;
}

export interface RawBuildInfo {
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly commit?: string | undefined;
  readonly builtAt?: string | undefined;
  readonly dirty?: boolean | string | undefined;
}

/**
 * Normalize whatever the build stamped in.
 *
 * **Never fails.** Invariant I9 — this is an observability concern, so it fails
 * open: a missing or malformed stamp degrades to `dev`/`unknown` rather than
 * stopping a process from booting. Refusing to start because the version string
 * was wrong would turn a cosmetic defect into an outage, and the outage would
 * be at three in the morning during a rollback.
 *
 * Anything unrecognized becomes `unknown`, which is honest — an empty string or
 * a literal `$COMMIT` that never got substituted is worse than admitting the
 * value is missing.
 */
export function buildInfo(raw: RawBuildInfo = {}): BuildInfo {
  const commit = (raw.commit ?? '').trim().toLowerCase();
  const version = (raw.version ?? '').trim();
  const builtAt = parseInstant(raw.builtAt);

  return {
    name: (raw.name ?? '').trim() || 'unknown',
    version: version === '' ? UNKNOWN_VERSION : version,
    commit: COMMIT_PATTERN.test(commit) ? commit : UNKNOWN_COMMIT,
    ...(builtAt === undefined ? {} : { builtAt }),
    dirty: raw.dirty === true || raw.dirty === 'true',
  };
}

function parseInstant(value: string | undefined): Date | undefined {
  if (value === undefined || value.trim() === '') return undefined;

  // A literal date, not a reading of the clock — M2 permits this, and there is
  // no clock to inject at the moment a build stamp is parsed.
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** The first seven characters, the way everyone actually quotes a sha. */
export function shortCommit(info: BuildInfo, length = 7): string {
  return info.commit === UNKNOWN_COMMIT
    ? UNKNOWN_COMMIT
    : info.commit.slice(0, length);
}

/**
 * One line for a startup log.
 *
 * `modular-hx-ts 1.4.0 (a1b2c3d, dirty, built 2026-01-01T00:00:00.000Z)`
 */
export function describe(info: BuildInfo): string {
  const parts = [shortCommit(info)];
  if (info.dirty) parts.push('dirty');
  if (info.builtAt !== undefined) {
    parts.push(`built ${info.builtAt.toISOString()}`);
  }

  return `${info.name} ${info.version} (${parts.join(', ')})`;
}

/**
 * A `User-Agent` for outbound requests.
 *
 * `modular-hx-ts/1.4.0 (+a1b2c3d)` — RFC 9110 product form. Worth the six lines:
 * when a dependency asks which of your deploys is hammering them, this is the
 * answer, and it is already in their logs.
 */
export function userAgent(info: BuildInfo): string {
  return `${info.name}/${info.version} (+${shortCommit(info)})`;
}

/**
 * The `/version` payload.
 *
 * Deliberately not the whole `BuildInfo`: the shape is a public API, and a
 * `Date` serializes differently depending on who does it. This is plain JSON
 * with an explicit ISO string.
 */
export function versionPayload(
  info: BuildInfo,
): Record<string, string | boolean> {
  return {
    name: info.name,
    version: info.version,
    commit: info.commit,
    dirty: info.dirty,
    ...(info.builtAt === undefined
      ? {}
      : { builtAt: info.builtAt.toISOString() }),
  };
}
