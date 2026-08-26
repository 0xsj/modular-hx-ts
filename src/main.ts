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
import {
  minutes,
  since,
  type Clock,
  type Sleeps,
  systemClock,
} from './shared/clock/index.js';
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
  sensitive,
  text,
  url,
  type Config,
  type Problem,
  type Source,
} from './shared/env/index.js';
import {
  inspect,
  report as reportSecrets,
  resolving,
  willBoot,
} from './shared/secrets/index.js';
import { makeLifecycle } from './shared/lifecycle/index.js';
import { makeHealth, servesTraffic } from './shared/health/index.js';
import { nodeServer } from './shared/httpx/index.js';
import { NO_PROXIES, trustedProxies } from './shared/ratelimit/index.js';
import { ALL_MIGRATIONS, wire } from './wire.js';
import { DEMO_PASSWORD, seedDemo } from './demo.js';
import {
  connect as connectPostgres,
  migrate as applyMigrations,
  type MigrationSet,
} from './shared/postgres/index.js';
import {
  Carrier,
  makeOrigins,
  type Origins,
} from './shared/provenance/index.js';
import {
  memoryTelemetry,
  noopTelemetry,
  type Telemetry,
} from './shared/telemetry/index.js';

/**
 * Everything constructed once, at boot.
 *
 * Grows as the layers land. When `wire.ts` arrives in phase 8 this moves there
 * and `main` shrinks to argument parsing and process lifetime.
 */
interface Kernel {
  /**
   * **`Sleeps` too**, which `systemClock` has always returned — the field was
   * just typed narrower than the value. `wire` needs both now that `retry` is
   * reachable from a context.
   */
  readonly clock: Clock & Sleeps;
  readonly random: Random;
  readonly ids: IdGenerator;
  readonly retry: Retrier;
  readonly breaker: Breaker;
  readonly provenance: Origins;
  readonly log: Logger;
  readonly telemetry: Telemetry;
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
    telemetry: wireTelemetry(config, log),
    // Neither half of an id is defaulted: `systemIds` composes the two
    // adapters rather than being one, which is what keeps rule `I5` free of
    // exemptions.
    ids,
    retry: makeRetry(clock, random),
    breaker: makeBreaker(clock),
  };
}

/**
 * Which telemetry adapter this process runs with.
 *
 * `none` is the default and the only one that ships today. `otlp` and
 * `prometheus` name exporters that live behind the same port; until that
 * adapter lands, choosing one is reported rather than honoured, because a
 * process that silently drops the traces it was configured to emit is worse
 * than one that says so.
 */
function wireTelemetry(config: AppConfig, log: Logger): Telemetry {
  if (config.traces !== 'none' || config.metrics !== 'none') {
    log.warn('telemetry exporters are not wired yet', {
      traces: config.traces,
      metrics: config.metrics,
      effective: 'none',
    });
  }
  return noopTelemetry();
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
  //
  // **`0` is legal and means *let the kernel choose*.** It was `min: 1`, which
  // refused an ephemeral bind — and an ephemeral bind is what anything running
  // two copies of this process at once needs, `make e2e` first among them. The
  // bound port is announced in the `ready` line, which is the only place it can
  // be learned from.
  port: integer('PORT', { fallback: 15430, min: 0, max: 65535 }),
  logLevel: oneOf('LOG_LEVEL', LEVELS, { fallback: 'info' }),
  logFormat: oneOf('LOG_FORMAT', ['console', 'json'], { fallback: 'console' }),
  colour: optional(flag('FORCE_COLOR')),
  traces: oneOf('TELEMETRY_TRACES', ['none', 'otlp'], { fallback: 'none' }),
  metrics: oneOf('TELEMETRY_METRICS', ['none', 'prometheus'], {
    fallback: 'none',
  }),
  databaseUrl: optional(url('DATABASE_URL')),

  // `mailer`. The password is a `sensitive` reader, so it arrives as a `Secret`
  // that cannot print itself, and `secrets` has already resolved a
  // `file://` or `env://` reference before `load` ever sees the value —
  // `SMTP_PASSWORD=file:///run/secrets/smtp#password` needs no code here.
  mailProvider: oneOf('MAIL_PROVIDER', ['memory', 'smtp', 'none'], {
    fallback: 'memory',
  }),
  smtpHost: text('SMTP_HOST', { fallback: '127.0.0.1' }),
  // ../PORTS.md offset +2 for this repository's 15420 base.
  smtpPort: integer('SMTP_PORT', { fallback: 15422, min: 1, max: 65535 }),
  smtpUsername: optional(text('SMTP_USERNAME')),
  smtpPassword: optional(sensitive('SMTP_PASSWORD')),
  smtpSecure: flag('SMTP_SECURE', { fallback: false }),
  mailFrom: text('MAIL_FROM', { fallback: 'noreply@example.com' }),

  // `crypto`. A JSON keyset, and a secret reference works unchanged:
  // `CRYPTO_KEYS=file:///run/secrets/keys` is a mounted Kubernetes secret that
  // `secrets` resolves before this schema ever sees it. Absent means the
  // ephemeral dev ring, which warns at startup.
  cryptoKeys: optional(sensitive('CRYPTO_KEYS')),

  // `ratelimit`. **No default, and both candidate defaults are wrong in the
  // same way** — `../MODULES.md` §5. Trusting forwarding headers by default
  // hands every caller a limit-evasion primitive and lets one exhaust another's
  // bucket by forging their address; *not* trusting them by default makes the
  // limiter global behind any load balancer, failing conformance case 40 on the
  // first day of a real deployment while looking safe. `none` is a legal
  // explicit value and is what development sets.
  // **Optional in the schema, required by `serve`.** It was required here, and
  // that made `migrate` refuse to run without a setting it cannot use — a
  // migration answers no HTTP and mounts no limiter. §5's *unset fails boot*
  // means boot, and boot is `serve`; the refusal lives there.
  trustedProxies: optional(text('TRUSTED_PROXIES')),
  /**
   * Mount `orgs`. **`false` must boot and serve** — `../CONTEXTS.md` §4.
   *
   * The flag exists to be turned off: it is the only mechanical test that
   * `identity`'s `OrgRoles` port is a real seam rather than a formality, and a
   * requirement satisfied in prose and never executed is one nobody has
   * checked.
   */
  orgsEnabled: flag('ORGS_ENABLED', { fallback: true }),
  exportsEnabled: flag('EXPORTS_ENABLED', { fallback: true }),
  webhooksEnabled: flag('WEBHOOKS_ENABLED', { fallback: true }),
  /**
   * Where export artifacts are written. Absent keeps them in memory.
   *
   * A directory rather than a bucket, because `I1` says memory mode needs no
   * external dependency and this blueprint has no object-store account. S3 is
   * the same port with a different `put`.
   */
  blobRoot: optional(text('BLOB_ROOT')),
  // The rate one process allows while the shared store is unreachable.
  // **Configured, never derived from a replica count**: a process must not be
  // told its own fleet size. Absent means the full limit, and during an outage
  // N replicas then admit N times it — said plainly rather than disguised by a
  // share calculation, because the outage took away the coordination that made
  // an aggregate meaningful.
  degradedLimit: optional(integer('RATELIMIT_DEGRADED', { min: 1 })),
  rateLimit: integer('RATELIMIT', { fallback: 120, min: 1 }),

  // `seed`. **The first administrator comes from configuration** —
  // `../CONTEXTS.md` §7.4. Both optional, and `seed` refuses when either is
  // unset: a default administrator password is one every deploy ships with.
  bootstrapEmail: optional(text('BOOTSTRAP_ADMIN_EMAIL')),
  bootstrapPassword: optional(sensitive('BOOTSTRAP_ADMIN_PASSWORD')),
  /**
   * Seed the world into **this** process at boot. `make dev` sets it.
   *
   * Rung 0a, and it exists because of a trap the criterion is about: in memory
   * mode `make seed` and `make dev` are two processes and two empty maps, so a
   * stranger who runs both in the documented order gets an empty system and no
   * indication why. Announced at boot rather than silent, and refused outside
   * memory mode — a process that seeds on boot seeds once per replica.
   */
  seedOnBoot: oneOf('SEED_ON_BOOT', ['none', 'admin', 'demo'], {
    fallback: 'none',
  }),
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
      traces: config.traces,
      metrics: config.metrics,
      pid: process.pid,
    });

    const clock = systemClock();
    const health = makeHealth({ clock });
    const lifecycle = makeLifecycle({ clock, reporter: kernel.log });

    // Registered **last**, so reverse order stops it **first**. That ordering
    // is the point: INFRASTRUCTURE.md §7.3 wants readiness to report draining
    // *before* anything closes, so the load balancer stops sending work while
    // the process is still fully assembled and in-flight requests can finish.
    //
    // `postgres`, `events` and `httpx` each become a component as they land,
    // registered ahead of this one — start order is dependency order, which is
    // what makes reverse-order shutdown correct rather than lucky.
    lifecycle.add({
      name: 'traffic',
      stop: async () => {
        health.drain();
        const report = await health.ready();
        kernel.log.info('draining', {
          // Readiness now refuses traffic; liveness deliberately still passes,
          // or the orchestrator would restart the process mid-drain.
          serves_traffic: servesTraffic(report),
          alive: servesTraffic(health.live()),
        });
      },
    });

    // **The refusal, where the limiter is.** `MODULES.md` §5: no silent
    // default, because trusting forwarding headers by default is a
    // limit-evasion primitive and not trusting them makes the limiter global
    // behind any load balancer. `none` is the legal explicit answer.
    let trust;
    try {
      trust = trustedProxies(config.trustedProxies);
    } catch (error) {
      kernel.log.error('TRUSTED_PROXIES', { why: String(error) });
      return 78; // EX_CONFIG
    }

    // **The contexts, mounted.** `CONTEXTS.md` §7.5: wire and serve before the
    // third context. Everything above this line was true of a process that
    // answered nothing.
    // `STORAGE=memory` opens nothing — invariant `I1`. `STORAGE=postgres` with
    // no DSN is a configuration mistake, refused here rather than becoming a
    // connection error on the first request.
    if (config.storage === 'postgres' && config.databaseUrl === undefined) {
      kernel.log.error('STORAGE=postgres but DATABASE_URL is not set');
      return 78; // EX_CONFIG
    }
    const db =
      config.storage === 'postgres' && config.databaseUrl !== undefined
        ? connectPostgres({
            dsn: config.databaseUrl,
            applicationName: 'modular-hx-ts:serve',
          })
        : undefined;
    const wired = wire({
      clock,
      build,
      ids: kernel.ids,
      random: kernel.random,
      telemetry: kernel.telemetry,
      log: kernel.log,
      health,
      tenant: 'default',
      // Throws when unset, which for a root means the process refuses to boot
      // rather than starting with a limiter that is either evadable or global.
      trust,
      orgs: config.orgsEnabled,
      exports: config.exportsEnabled,
      webhooks: config.webhooksEnabled,
      ...(config.blobRoot === undefined ? {} : { blobRoot: config.blobRoot }),
      rateLimit: config.rateLimit,
      ...(config.degradedLimit === undefined
        ? {}
        : { degradedLimit: config.degradedLimit }),
      ...(db === undefined ? {} : { db }),
      ...(config.mailProvider === 'smtp'
        ? { smtp: { host: config.smtpHost, port: config.smtpPort } }
        : {}),
    });

    // **Announced, not implied.** A root that skips something says what and
    // why, at boot — which is how a slot nobody filled stops being invisible.
    // An empty list is a claim that nothing was left out.
    for (const gap of wired.skipped) {
      kernel.log.warn('not wired', { what: gap.what, why: gap.why });
    }

    const server = nodeServer({
      host: config.host,
      port: config.port,
      handler: wired.handler,
      onError: (error: unknown) => {
        kernel.log.error('a connection failed outside any request', {
          err: error,
        });
      },
    });

    // **The relay, as a component.** In memory mode `dispatcher.start` is
    // absent and this adds nothing; in Postgres mode it is what moves an event
    // out of the outbox table and into `audit`. Registered *before* `http`, so
    // reverse-order shutdown stops accepting requests first and lets the relay
    // finish what those requests produced.
    if (wired.events.dispatcher.start !== undefined) {
      lifecycle.add({
        name: 'events',
        start: async () => {
          await wired.events.dispatcher.start?.();
        },
        stop: async () => {
          await wired.events.dispatcher.stop?.();
          // One last pass, so an event published by the final request is not
          // left in the table for the next deploy to find.
          await wired.events.dispatcher.drain();
        },
      });
    }

    // **The export worker, as a component.** Registered before `http`, so
    // reverse-order shutdown stops accepting requests first and lets the worker
    // finish what those requests asked for.
    if (wired.worker !== undefined) {
      const loop = wired.worker;
      lifecycle.add({
        name: 'exports-worker',
        start: async () => {
          await loop.start();
        },
        stop: async () => {
          await loop.stop();
          await loop.drain();
        },
      });
    }

    lifecycle.add({
      name: 'http',
      start: async () => {
        await server.start();
      },
      // Stopped **before** `traffic` below only because lifecycle reverses:
      // readiness reports draining first, then the socket closes, then
      // in-flight requests finish.
      stop: async () => {
        await server.stop();
      },
    });

    if (db !== undefined) {
      lifecycle.add({
        name: 'postgres',
        stop: async () => {
          await db.close();
        },
      });
    }

    const started = await lifecycle.start();
    if (isErr(started)) {
      kernel.log.error('could not start', { err: started.error });
      return 70; // EX_SOFTWARE
    }

    if (config.seedOnBoot !== 'none') {
      if (config.storage !== 'memory') {
        kernel.log.error('SEED_ON_BOOT is for memory mode only', {
          why: 'a process that seeds on boot seeds once per replica; use `make seed`',
          storage: config.storage,
        });
        return 78; // EX_CONFIG
      }
      const email = config.bootstrapEmail ?? 'admin@example.test';
      const password = config.bootstrapPassword?.expose() ?? 'admin-password-1';
      await wired.seed({ email, password });
      if (config.seedOnBoot === 'demo') {
        await seedDemo({
          handler: wired.handler,
          origins: kernel.provenance,
          administrator: { email, password },
          log: kernel.log,
        });
      }
      // **Said out loud.** These are development credentials in a process with
      // no database; printing them is the difference between a stranger
      // reaching something and reading source to find out how.
      // **Deliberately printed, and the field names are chosen to survive.**
      // `redact` matches on field name and would hide a value called
      // `administrator_password` — correctly, in every other context. Rung 0a
      // is the one place a credential has to reach the terminal, so the field
      // says what it is for rather than what it is.
      kernel.log.info('seeded on boot', {
        log_in_as: email,
        log_in_with: password,
        ...(config.seedOnBoot === 'demo'
          ? { everybody_else: `${DEMO_PASSWORD} (see \`make curl\`)` }
          : {}),
        seeded: config.seedOnBoot,
        why: 'SEED_ON_BOOT — memory mode only, and this data dies with the process',
      });
    }

    const readiness = await health.ready();
    const bound = server.address();
    kernel.log.info('ready', {
      status: readiness.status,
      serves_traffic: servesTraffic(readiness),
      checks: readiness.checks.length,
      listening: bound !== undefined,
      host: bound?.host ?? config.host,
      // The **bound** port, not the configured one: with `PORT=0` the kernel
      // picks, and a test needs to know which.
      port: bound?.port ?? config.port,
      // **`_known`, and the suffix is the whole point.** `serve` does not
      // migrate — `migrate` is a separate command precisely so a deploy can
      // apply schema before it rolls pods. This field is the manifest size,
      // and spelled `migrations=12` on a *ready* line it read as *twelve
      // applied*: a boot against a freshly dropped schema announced healthy,
      // reported twelve, and then failed every request, because the number
      // describing the code was mistaken for a number describing the database.
      migrations_known: wired.migrations.length,
    });

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
  const { clock, ids, random, retry, breaker, log, telemetry } = kernel;

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

    // A real span through whatever exporter is configured, and the same work
    // against an in-memory recorder — which is the only way to *show* what a
    // span carries when there is no collector to look at.
    await telemetry.tracer.inSpan('doctor', (span) => {
      span.setAttribute('checks', 'wiring');
    });
    telemetry.meter.counter('doctor_runs').add(1);

    const recorder = memoryTelemetry(clock);
    await recorder.tracer.inSpan('self check', () => undefined);
    const [span] = recorder.spans();
    log.info('telemetry', {
      span: span?.name,
      // Correlation came from the ambient provenance — telemetry reads it, and
      // never becomes the source of it.
      correlated:
        span?.attributes['correlation_id'] === Carrier.require().correlationId,
      // Nothing left open: `inSpan` ends its span whatever happens.
      open: recorder.open(),
    });

    log.info('provenance', {
      // Ambient, from a call that was handed nothing.
      correlation: Carrier.require().correlationId,
    });

    log.info('wiring ok');
    return 0;
  });
}

/**
 * `secrets` — every reference, its source, and a will-it-boot exit code.
 *
 * `../MODULES.md` §2 requires it, and the reason is the restart loop it
 * replaces: a broken reference otherwise surfaces as a process that exits 78
 * with one line, then exits 78 again with the next, one variable per restart,
 * against a deployment that is already down.
 *
 * **Needs no configuration**, like `version` — a broken secret is precisely
 * when configuration will not load, so a check that required it would be
 * unavailable exactly when it is wanted.
 *
 * No value is printed. That guarantee belongs to `secrets`, which is why the
 * rendering lives there and this function only chooses the variables.
 */
function secrets(source: Source): number {
  const inspected = inspect(
    source,
    Object.values(SCHEMA).map((reader) => reader.variable),
  );

  process.stdout.write(`${reportSecrets(inspected)}\n`);
  return willBoot(inspected) ? 0 : 78; // EX_CONFIG
}

function version(source: Source): number {
  process.stdout.write(
    `${JSON.stringify(versionPayload(readBuildInfo(source)), null, 2)}\n`,
  );
  return 0;
}

/**
 * The migration registry.
 *
 * Every context contributes its own set as it lands — `identity`, `audit`,
 * `orgs` — and `../MODULES.md` §3 namespaces them per context so two can both
 * have an `0001`.
 *
 * **This was `[]` while every test was green**, and would have stayed `[]`
 * until somebody ran `serve` against a real database and got *relation
 * "identity_users" does not exist*. The integration suites each create their
 * own schema, so nothing in the test tree ever asked this list what was in it.
 * It now comes from the same place the handler does, which is the only way the
 * two cannot disagree.
 */
const MIGRATIONS: MigrationSet = ALL_MIGRATIONS;

/**
 * Mint the bootstrap administrator. **`../CONTEXTS.md` §7.4.**
 *
 * A separate command rather than something `serve` does at boot, for the same
 * reason `migrate` is: a process that seeds on boot seeds once per replica, and
 * the one that loses the race is the one that reports a confusing error.
 *
 * **Refused when unset.** A default password is worse than no administrator —
 * it is the same credential in every deploy, and the `.env` it lives in gets
 * copied. Exit `78` (`EX_CONFIG`), the same as any other configuration problem.
 */
async function seed(
  kernel: Kernel,
  config: AppConfig,
  demo: boolean,
): Promise<number> {
  return Carrier.run(kernel.provenance.forCli('seed'), async () => {
    const email = config.bootstrapEmail;
    const password = config.bootstrapPassword;

    if (email === undefined || password === undefined) {
      kernel.log.error(
        'BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD must both be set',
        {
          // **The variable names, under a key that names neither.** The first
          // two attempts were `password_set` and `secret_supplied`, and the
          // logger redacted both — over a boolean, so the diagnostic said
          // `[redacted]` and nothing else. The redaction rule matches on the
          // field name and is right to; naming the concept in a diagnostic
          // field is what was wrong. This says which variable to go and set.
          missing: [
            ...(email === undefined ? ['BOOTSTRAP_ADMIN_EMAIL'] : []),
            ...(password === undefined ? ['BOOTSTRAP_ADMIN_PASSWORD'] : []),
          ],
        },
      );
      return 78; // EX_CONFIG
    }

    if (config.storage === 'postgres' && config.databaseUrl === undefined) {
      kernel.log.error('STORAGE=postgres but DATABASE_URL is not set');
      return 78;
    }

    // **In memory mode this seeds a store that dies with the process.** Said
    // rather than refused: `seed` is how `make dev` gets an account, and the
    // memory run is a real mode.
    const db =
      config.storage === 'postgres' && config.databaseUrl !== undefined
        ? connectPostgres({
            dsn: config.databaseUrl,
            applicationName: 'modular-hx-ts:seed',
          })
        : undefined;

    try {
      const wired = wire({
        clock: kernel.clock,
        build: readBuildInfo(fromProcess()),
        ids: kernel.ids,
        random: kernel.random,
        telemetry: kernel.telemetry,
        log: kernel.log,
        health: makeHealth({ clock: systemClock() }),
        tenant: 'default',
        // **A seeding process answers no HTTP**, so there is nothing for a
        // trusted set to protect and nothing to refuse over. `wire` still
        // builds a chain, and this is the honest value for one nobody serves.
        trust: NO_PROXIES,
        orgs: config.orgsEnabled,
        exports: config.exportsEnabled,
        webhooks: config.webhooksEnabled,
        rateLimit: config.rateLimit,
        ...(db === undefined ? {} : { db }),
      });

      const outcome = await wired.seed({
        email,
        password: password.expose(),
      });

      if (demo) {
        // **Rung 0a.** The administrator is the base case; this is the world a
        // stranger logs into. Driven over the same handler `serve` mounts, so
        // every record it leaves has a real request behind it.
        await seedDemo({
          handler: wired.handler,
          origins: kernel.provenance,
          administrator: { email, password: password.expose() },
          log: kernel.log,
        });
      }

      kernel.log.info('seeded', {
        // Never the password, and the address is not a secret — an operator
        // needs to know *which* account exists.
        email,
        administrator: outcome,
        storage: config.storage,
      });
      if (outcome === 'exists') {
        kernel.log.info('nothing to do', {
          why: 'the bootstrap administrator already exists; seeding is idempotent by address',
        });
      }
      return 0;
    } catch (error) {
      kernel.log.error('seeding failed', { err: error });
      return 70; // EX_SOFTWARE
    } finally {
      await db?.close();
    }
  });
}

async function migrate(kernel: Kernel, config: AppConfig): Promise<number> {
  return Carrier.run(kernel.provenance.forMigration(), async () => {
    if (config.databaseUrl === undefined) {
      // A missing DSN is a configuration problem, not a migration failure.
      kernel.log.error('DATABASE_URL is not set');
      return 78; // EX_CONFIG
    }

    const db = connectPostgres({
      dsn: config.databaseUrl,
      // A migration is the one caller that legitimately runs longer than a
      // request; the lock budget is deliberately left at its default, because
      // a migration that cannot get its lock should fail fast rather than hold
      // the deploy open while it blocks live traffic.
      statementTimeout: minutes(10),
      applicationName: 'modular-hx-ts:migrate',
      maxConnections: 1,
    });

    try {
      const started = kernel.clock.elapsed();
      const report = await applyMigrations(db, MIGRATIONS);

      kernel.log.info('migrated', {
        applied: report.applied.length,
        already_applied: report.alreadyApplied,
        took_ms: Math.round(since(kernel.clock, started)),
      });
      for (const one of report.applied) {
        kernel.log.info('applied', { context: one.context, name: one.name });
      }
      return 0;
    } catch (error) {
      kernel.log.error('migration failed', { err: error });
      return 70; // EX_SOFTWARE
    } finally {
      await db.close();
    }
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
    case 'secrets':
      // Same reasoning: a broken reference is why configuration will not load,
      // so the command that diagnoses it cannot depend on configuration.
      return secrets(source);
    default:
      break;
  }

  const config = configure(source);
  if (config === undefined) return 78; // EX_CONFIG

  switch (command) {
    case 'serve':
      return serve(source, config);
    case 'migrate':
      return migrate(wireKernel(config), config);
    case 'doctor':
      return doctor(wireKernel(config));
    case 'seed':
      return seed(wireKernel(config), config, argv.includes('--demo'));
    default:
      process.stderr.write(
        `unknown command: ${command}\n` +
          `usage: modular-hx-ts [serve|version|secrets|migrate|seed [--demo]|doctor]\n`,
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
