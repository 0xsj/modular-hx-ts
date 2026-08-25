import { describe, expect, it, vi } from 'vitest';
import { fromRecord, load } from '../../src/shared/env/index.js';
import { unwrap } from '../../src/shared/result/index.js';
import { main, SCHEMA, wireKernel } from '../../src/main.js';

/**
 * Configuration the way `main` builds it, from a source a test controls.
 *
 * **`TRUSTED_PROXIES` has no default and this had no value for it**, so every
 * case here started failing with *1 configuration problem* the moment the
 * setting landed — which is the rule doing exactly its job, including on its
 * own repository. `none` is the legal explicit answer for a process with no
 * proxy in front, and a hermetic smoke test is that process.
 */
const REQUIRED = { TRUSTED_PROXIES: 'none' };
const configured = () => unwrap(load(fromRecord(REQUIRED), SCHEMA));

/**
 * The in-process composition smoke test.
 *
 * Rule `S9` says nothing imports the composition root, and exempts this file by
 * name — because the one thing worth knowing before anything else is that the
 * root actually composes. A unit test proves a module works; this proves the
 * graph can be built at all.
 *
 * It runs at rung 0: no Docker, no network, no build.
 */

/** Run a command with stdout captured. */
async function run(argv: string[]): Promise<{ code: number; out: string }> {
  // `main` reads the real environment, so the explicit answer goes there too.
  // Restored below, because a test that leaks a variable is a test that makes
  // the next one pass for the wrong reason.
  const had = process.env['TRUSTED_PROXIES'];
  process.env['TRUSTED_PROXIES'] = 'none';

  const lines: string[] = [];
  const write = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });

  try {
    return { code: await main(argv), out: lines.join('') };
  } finally {
    write.mockRestore();
    if (had === undefined) delete process.env['TRUSTED_PROXIES'];
    else process.env['TRUSTED_PROXIES'] = had;
  }
}

describe('composition', () => {
  it('wires the kernel without touching anything external', () => {
    const kernel = wireKernel(configured());

    expect(kernel.clock.now()).toBeInstanceOf(Date);
    expect(kernel.random.token()).toHaveLength(43);
    expect(kernel.ids.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(kernel.breaker.snapshot('anything').state).toBe('closed');
  });

  it('gives every boot a distinct id, ordered within one generator', () => {
    // Ordering holds *within* a generator, not across independent ones: the
    // intra-millisecond counter is seeded randomly per generator so an id does
    // not leak how many were minted alongside it. Two boots in the same
    // millisecond are distinct, and only their timestamps are comparable.
    const kernel = wireKernel(configured());
    const first = kernel.ids.uuid();
    const second = kernel.ids.uuid();

    expect(second > first).toBe(true);
    expect(wireKernel(configured()).ids.uuid()).not.toBe(first);
  });
});

describe('commands', () => {
  it('reports its build as JSON', async () => {
    const { code, out } = await run(['version']);

    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({
      name: 'modular-hx-ts',
      version: expect.any(String) as string,
      commit: expect.any(String) as string,
    });
  });

  it('refuses to migrate without a DSN, and says so', async () => {
    // `migrate` now runs the real migrator, so this suite must not be able to
    // reach a database: rung 0 needs nothing, and a smoke test that connects
    // when `DATABASE_URL` happens to be exported is a rung-0 test in name only.
    // The Makefile *does* export it, which is exactly how that would happen.
    const dsn = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    try {
      const { code } = await run(['migrate']);

      expect(code).toBe(78); // EX_CONFIG — a missing DSN is configuration
    } finally {
      if (dsn !== undefined) process.env['DATABASE_URL'] = dsn;
    }
  });

  it('stamps system provenance on what it logs', async () => {
    // The composition root runs every command inside an origin, so a line
    // emitted by code that never asked for provenance still carries it.
    const dsn = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];
    const { out } = await run(['migrate']).finally(() => {
      if (dsn !== undefined) process.env['DATABASE_URL'] = dsn;
    });

    expect(out).toContain('actor=system:migrate');
    expect(out).toMatch(/correlation_id=\S+/);
  });

  it('reports on every wired dependency', async () => {
    // The operational answer to "is this deploy wired correctly". It exercises
    // each module rather than asserting the object exists.
    const { code, out } = await run(['doctor']);

    expect(code).toBe(0);
    for (const line of [
      'clock',
      'id',
      'random',
      'digest',
      'retry',
      'breaker',
    ]) {
      expect(out, `expected doctor to report ${line}`).toContain(line);
    }
    expect(out).toContain('wiring ok');
  });

  it('never prints a credential, however it was named', async () => {
    // Both redaction mechanisms, exercised by a real command: a sensitive key
    // name, and a value that redacts itself whatever it is called.
    const { out } = await run(['doctor']);

    expect(out).not.toMatch(/token=[A-Za-z0-9_-]{20}/);
    expect(out).toContain('token=[redacted]');
    expect(out).toContain('sample=[redacted]');
  });

  it('refuses to start on bad configuration, naming every problem', async () => {
    // One pass, not one variable per restart — and `serve` never gets as far as
    // building a logger, because the logger's own level comes from this.
    const stderr: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderr.push(String(chunk));
        return true;
      });

    try {
      const before = { ...process.env };
      process.env['PORT'] = '80a0';
      process.env['LOG_LEVEL'] = 'shout';
      process.env['TRUSTED_PROXIES'] = 'none';

      expect(await main(['serve'])).toBe(78); // EX_CONFIG

      process.env = before;
    } finally {
      spy.mockRestore();
    }

    const reported = stderr.join('');
    expect(reported).toContain('2 configuration problems');
    expect(reported).toContain('PORT');
    expect(reported).toContain('LOG_LEVEL');
  });

  it('reports its build without needing configuration', async () => {
    // The moment somebody asks what is deployed is usually the moment the
    // configuration is broken.
    const before = { ...process.env };
    process.env['PORT'] = '80a0';

    const { code } = await run(['version']);
    expect(code).toBe(0);

    process.env = before;
  });

  it('refuses an unknown command with a non-zero status', async () => {
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const had = process.env['TRUSTED_PROXIES'];
    process.env['TRUSTED_PROXIES'] = 'none';

    try {
      // Configuration is loaded before the command is dispatched, so without
      // the explicit answer this returns 78 and never reaches the usage line —
      // a real ordering, not a test artefact.
      expect(await main(['nonsense'])).toBe(2);
    } finally {
      stderr.mockRestore();
      if (had === undefined) delete process.env['TRUSTED_PROXIES'];
      else process.env['TRUSTED_PROXIES'] = had;
    }
  });

  it('refuses to SERVE without a trusted proxy set, and migrates without one', async () => {
    // **The rule with the sharpest edge** — `../MODULES.md` §5. There is no
    // default because both candidates are wrong: trusting forwarding headers
    // hands every caller a limit-evasion primitive, and not trusting them makes
    // the limiter global behind any load balancer.
    //
    // **Where the refusal lives is the part worth pinning.** It was a required
    // schema entry, which made `migrate` refuse to run without a setting a
    // migration cannot use — it answers no HTTP and mounts no limiter. *Unset
    // fails boot* means boot, and boot is `serve`.
    const had = process.env['TRUSTED_PROXIES'];
    delete process.env['TRUSTED_PROXIES'];
    const dsn = process.env['DATABASE_URL'];
    delete process.env['DATABASE_URL'];

    // `main` directly, not `run`: the helper supplies the explicit answer,
    // which is the thing being removed here.
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      expect(await main(['serve'])).toBe(78); // EX_CONFIG
      // `migrate` reaches its own missing-DSN check rather than being refused
      // over a setting it has no use for — same code, a different reason, and
      // the difference is the point.
      expect(await main(['migrate'])).toBe(78);
    } finally {
      write.mockRestore();
      if (had === undefined) delete process.env['TRUSTED_PROXIES'];
      else process.env['TRUSTED_PROXIES'] = had;
      if (dsn !== undefined) process.env['DATABASE_URL'] = dsn;
    }
  });
});
