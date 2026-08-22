/**
 * The process entry point. **L5 composition root** — imported by nothing.
 *
 * This is the only place that knows concrete types (`../ARCHITECTURE.md` §5),
 * and the only place permitted to read the environment. Rule `S9` enforces the
 * first half: nothing in `src/` may import this file.
 *
 * **It is deliberately early.** `docs/TREE.md` puts the composition root in
 * phase 8; this skeleton lands in phase 2 so that L1 modules — `logger`,
 * `provenance`, `lifecycle`, `health` — can be exercised through a real
 * process as they are built, rather than only through unit tests. It stays
 * minimal until phase 8, and every line below that says "until X lands" is a
 * placeholder with a named successor.
 */

import { pathToFileURL } from 'node:url';
import {
  buildInfo,
  describe as describeBuild,
  versionPayload,
} from './shared/buildinfo/index.js';
import { since, type Clock, systemClock } from './shared/clock/index.js';
import { digest } from './shared/digest/index.js';
import { unavailable } from './shared/errors/index.js';
import { isErr, isOk, unwrap } from './shared/result/index.js';
import { secret } from './shared/redact/index.js';
import { systemIds, timestampOf } from './shared/id/index.js';
import { type Random, systemRandom } from './shared/random/index.js';
import { makeRetry, type Retrier } from './shared/retry/index.js';
import { makeBreaker, type Breaker } from './shared/breaker/index.js';
import type { IdGenerator } from './shared/id/index.js';
import {
  consoleLogger,
  detectColour,
  jsonLogger,
  LEVELS,
  type Logger,
} from './shared/logger/index.js';
import {
  flag,
  fromProcess,
  integer,
  load,
  oneOf,
  optional,
  text,
  url,
  type Config,
  type Problem,
  type Source,
} from './shared/env/index.js';
import { resolving } from './shared/secrets/index.js';
import { makeLifecycle } from './shared/lifecycle/index.js';
import {
  Carrier,
  makeOrigins,
  type Origins,
} from './shared/provenance/index.js';

/**
 * Everything constructed once, at boot.
 *
 * Grows as the layers land. When `wire.ts` arrives in phase 8 this moves there
 * and `main` shrinks to argument parsing and process lifetime.
 */
interface Kernel {
  readonly clock: Clock;
  readonly random: Random;
  readonly ids: IdGenerator;
  readonly retry: Retrier;
  readonly breaker: Breaker;
  readonly provenance: Origins;
  readonly log: Logger;
}

export function wireKernel(config: AppConfig): Kernel {
  const clock = systemClock();
  const random = systemRandom();
  const ids = systemIds(clock, (count) => random.bytes(count));

  // The one switch: a person reading a terminal, or a log pipeline. Colour is
  // decided here and passed in, so the formatter stays deterministic.
  const log =
    config.logFormat === 'json'
      ? jsonLogger({ clock, level: config.logLevel })
      : consoleLogger({
          clock,
          level: config.logLevel,
          // Configuration when stated, otherwise what the terminal supports.
          colour: config.colour ?? detectColour(),
        });

  return {
    clock,
    random,
    provenance: makeOrigins(ids),
    log,
    // Neither half of an id is defaulted: `systemIds` composes the two
    // adapters rather than being one, which is what keeps rule `I5` free of
    // exemptions.
    ids,
    retry: makeRetry(clock, random),
    breaker: makeBreaker(clock),
  };
}

/**
 * Configuration, read in the one place allowed to read it.
 *
 * Until `env` lands this is a direct read with no schema and no validation.
 * `env` replaces it with a declared schema per component, every problem
 * reported at once, and secret references resolved before parsing.
 */
/**
 * What this process needs from its environment.
 *
 * Declared here because the composition root is what assembles a running
 * process; each module contributes the readers for what it owns as the layers
 * land, which is what `MODULES.md` means by *components declare their own
 * schema*. Nothing keeps a central list of every variable in the system.
 */
export const SCHEMA = {
  storage: oneOf('STORAGE', ['memory', 'postgres'], { fallback: 'memory' }),
  host: text('HOST', { fallback: '127.0.0.1' }),
  // ../PORTS.md offset +10 for this repository's 15420 base.
  port: integer('PORT', { fallback: 15430, min: 1, max: 65535 }),
  logLevel: oneOf('LOG_LEVEL', LEVELS, { fallback: 'info' }),
  logFormat: oneOf('LOG_FORMAT', ['console', 'json'], { fallback: 'console' }),
  colour: optional(flag('FORCE_COLOR')),
  databaseUrl: optional(url('DATABASE_URL')),
} as const;

type AppConfig = Config<typeof SCHEMA>;

/**
 * The build stamp.
 *
 * Read through the same `Source`, not `process.env` directly, so `secrets` can
 * wrap it later and so a test can supply one. It is deliberately not part of
 * `SCHEMA`: `buildinfo` fails open on a bad stamp, and a schema that refused to
 * start over a malformed version string would turn a cosmetic defect into an
 * outage.
 */
function readBuildInfo(source: Source): ReturnType<typeof buildInfo> {
  return buildInfo({
    name: 'modular-hx-ts',
    version: source.get('APP_VERSION'),
    commit: source.get('APP_COMMIT'),
    builtAt: source.get('APP_BUILT_AT'),
    dirty: source.get('APP_DIRTY'),
  });
}

async function serve(source: Source, config: AppConfig): Promise<number> {
  const build = readBuildInfo(source);
  const kernel = wireKernel(config);

  // Everything the process does runs inside boot provenance, so every line —
  // including from code that never asked for it — carries one correlation id.
  return Carrier.run(kernel.provenance.forBoot(), async () => {
    kernel.log.info('starting', {
      build: describeBuild(build),
      storage: config.storage,
      pid: process.pid,
    });

    const lifecycle = makeLifecycle({
      clock: systemClock(),
      reporter: kernel.log,
    });

    // Nothing to register yet. `postgres`, `events` and `httpx` each become a
    // component as they land, and start order here is their dependency order —
    // which is what makes reverse-order shutdown correct rather than lucky.
    lifecycle.add({
      name: 'process',
      stop: () => {
        kernel.log.info('ready to exit', {
          listening: false,
          host: config.host,
          port: config.port,
        });
      },
    });

    const started = await lifecycle.start();
    if (isErr(started)) {
      kernel.log.error('could not start', { err: started.error });
      return 70; // EX_SOFTWARE
    }

    // A second signal means the operator has stopped waiting.
    const release = lifecycle.handleSignals(() => {
      process.exit(130);
    });

    await lifecycle.stopped();
    release();

    return 0;
  });
}

/**
 * Exercise every wired dependency and say what happened.
 *
 * The operational answer to "is this deploy wired correctly" — run it after a
 * config change, or when something is behaving oddly and you want to know
 * whether the process even composed. It grows a line per adapter as they land.
 *
 * **Not a health check.** `health` (L1) brings liveness and readiness probes
 * for a running process; this is a command a person runs once, and it is
 * allowed to be slow and chatty in a way a probe is not.
 */
async function doctor(kernel: Kernel): Promise<number> {
  const { clock, ids, random, retry, breaker, log } = kernel;

  return Carrier.run(kernel.provenance.forCli('doctor'), async () => {
    log.info('checking wiring', {
      build: describeBuild(readBuildInfo(fromProcess())),
    });

    const startedAt = clock.elapsed();
    log.info('clock', {
      now: clock.now(),
      // Two readings, and only this one may measure a duration — rule M13.
      elapsed_ms: Math.round(since(clock, startedAt) * 1000) / 1000,
    });

    const id = ids.uuid();
    log.info('id', {
      sample: id,
      // A v7 id carries its own creation time, which is why it sorts.
      encodes: unwrap(timestampOf(id)),
    });

    log.info('random', {
      // Two ways a secret is kept out of a log, in one line: this key matches
      // the sensitive-key list…
      token: random.token(),
      // …and this value redacts itself whatever it is called.
      sample: secret(random.token()),
    });

    log.info('digest', { of_true: unwrap(digest({ ok: true })) });

    // A real retry: fails once as Unavailable, then succeeds. Proves retry,
    // clock and random are wired to each other and not just present.
    let attempts = 0;
    const flaky = (): Promise<string> => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(unavailable('first attempt always fails'))
        : Promise.resolve('recovered');
    };
    const recovered = await retry(flaky, 'self check', {
      onRetry: ({ attempt, delay }) => {
        log.warn('retrying', { attempt, delay_ms: delay });
      },
    });
    log.info('retry', { attempts, recovered: isOk(recovered) });

    const circuit = breaker.snapshot('self-check');
    log.info('breaker', {
      state: circuit.state,
      failures: circuit.failures,
      total: circuit.total,
    });

    log.info('provenance', {
      // Ambient, from a call that was handed nothing.
      correlation: Carrier.require().correlationId,
    });

    log.info('wiring ok');
    return 0;
  });
}

function version(source: Source): number {
  process.stdout.write(
    `${JSON.stringify(versionPayload(readBuildInfo(source)), null, 2)}\n`,
  );
  return 0;
}

function migrate(kernel: Kernel): number {
  // `make migrate` calls this. No context owns a migration set yet, so there is
  // genuinely nothing to apply — which is different from failing.
  return Carrier.run(kernel.provenance.forMigration(), () => {
    kernel.log.info('nothing to migrate', { applied: 0 });
    return 0;
  });
}

/**
 * Configuration, or a listing of everything wrong with it.
 *
 * The one place a bad environment stops the process — and it reports **every**
 * problem, so a broken deploy is fixed in one pass rather than one variable per
 * restart. There is no logger yet at this point, deliberately: the logger's own
 * level and format come from this, so a failure here has to be plain text on
 * stderr.
 */
function configure(source: Source): AppConfig | undefined {
  // Secret references resolve first — ARCHITECTURE.md §8 — by wrapping the
  // source. `load` never learns anything happened.
  const secrets = resolving(source);
  const config = load(secrets.source, SCHEMA);

  // A broken reference and a bad value are both configuration problems, and an
  // operator should see all of them at once. A reference that failed replaces
  // `is required` for the same variable: "no such file" is the useful half.
  const broken = secrets.problems();
  const reported: Problem[] = [
    ...broken,
    ...(config.ok
      ? []
      : config.error.fields
          .filter((field) => !broken.some((p) => p.variable === field.field))
          .map((field) => ({
            variable: field.field,
            message: field.message,
          }))),
  ];

  if (reported.length === 0 && config.ok) return config.value;

  process.stderr.write(`${report(reported)}\n`);
  return undefined;
}

/** The same shape `env.explain` produces, over problems from both modules. */
function report(problems: readonly Problem[]): string {
  const width = Math.max(0, ...problems.map((p) => p.variable.length));
  const summary =
    problems.length === 1
      ? '1 configuration problem'
      : `${String(problems.length)} configuration problems`;

  return [
    summary,
    ...problems.map((p) => `  ${p.variable.padEnd(width)}  ${p.message}`),
  ].join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  const source = fromProcess();

  switch (command) {
    case 'version':
      // Answers without configuration, so a broken deploy can still be
      // identified — which is exactly when somebody asks what is deployed.
      return version(source);
    default:
      break;
  }

  const config = configure(source);
  if (config === undefined) return 78; // EX_CONFIG

  switch (command) {
    case 'serve':
      return serve(source, config);
    case 'migrate':
      return migrate(wireKernel(config));
    case 'doctor':
      return doctor(wireKernel(config));
    default:
      process.stderr.write(
        `unknown command: ${command}\n` +
          `usage: modular-hx-ts [serve|version|migrate|doctor]\n`,
      );
      return 2;
  }
}

// A rejection nobody handled is a bug, and the default behaviour of printing a
// warning and continuing is how a half-dead process keeps serving traffic.
process.on('unhandledRejection', (reason: unknown) => {
  process.stderr.write(`unhandled rejection: ${String(reason)}\n`);
  process.exitCode = 1;
  process.exit(1);
});

/**
 * Run only when executed, not when imported.
 *
 * Rule `S9` exempts test files from "nothing imports the root" precisely so an
 * in-process composition smoke test can exist. That test has to be able to
 * import this file without the process booting and then refusing to exit.
 */
const entry = process.argv[1];
const invokedDirectly =
  entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
