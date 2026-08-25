/**
 * The real binary, started as a child process. **Test tooling, rung 3.**
 *
 * `../../INFRASTRUCTURE.md` §1: rung 3 is *journeys against the real binary*.
 * Not the handler, not a `supertest` wrapper around an in-process app — the
 * thing `make run` starts, over a socket, with an environment and an exit code.
 *
 * **The reason it is a child process and not an import.** Everything below this
 * line was green while `src/main.ts` mounted no routes at all: unit suites
 * called handlers directly, contract suites called adapters directly, and the
 * composition smoke test called `wire()` without ever asking whether anything
 * called `wire()`. A suite that imports the app cannot fail that way, so it
 * cannot catch it either. This one starts `main.ts serve` and asks the port.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export interface Started {
  /** `http://127.0.0.1:<bound port>` — never the configured one. */
  readonly base: string;
  /** Every structured line the process logged, in order. */
  readonly logs: readonly Record<string, unknown>[];
  /** What the root announced it had not wired. */
  readonly skipped: readonly { what: string; why: string }[];
  stop(): Promise<number | null>;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Start `main.ts serve` and wait until it says it is listening.
 *
 * **Waits for the `ready` line rather than polling the port**, because the port
 * is in that line: the process is started with `PORT=0` so two suites can run
 * without agreeing on a number, and the kernel's choice is only knowable from
 * what the process printed.
 */
export async function serve(
  env: Record<string, string> = {},
): Promise<Started> {
  const child = spawn('node', ['--import', 'tsx', 'src/main.ts', 'serve'], {
    cwd: ROOT,
    env: {
      ...process.env,
      LOG_FORMAT: 'json',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: '0',
      STORAGE: 'memory',
      MAIL_PROVIDER: 'memory',
      // No default, by rule — `MODULES.md` §5. `none` is the legal explicit
      // answer, and a test process with no proxy in front is exactly that.
      TRUSTED_PROXIES: 'none',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs: Record<string, unknown>[] = [];
  const stderr: string[] = [];
  let base: string | undefined;
  let ready: (() => void) | undefined;
  const listening = new Promise<void>((resolve) => {
    ready = resolve;
  });

  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        stderr.push(line);
        continue;
      }
      logs.push(parsed);
      if (parsed['msg'] === 'ready' && parsed['listening'] === true) {
        base = `http://${String(parsed['host'])}:${String(parsed['port'])}`;
        ready?.();
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr.push(chunk);
  });

  const died = once(child, 'exit').then(() => {
    throw new Error(
      `the process exited before it was ready:\n${stderr.join('')}`,
    );
  });

  await Promise.race([listening, died]);
  died.catch(() => undefined);

  if (base === undefined) throw new Error('no bound address was announced');

  return {
    base,
    logs,
    skipped: logs
      .filter((line) => line['msg'] === 'not wired')
      .map((line) => ({
        what: String(line['what']),
        why: String(line['why']),
      })),
    async stop() {
      if (child.exitCode !== null) return child.exitCode;
      // **SIGTERM, not SIGKILL** — the graceful path is part of what rung 3 is
      // testing, and killing it would leave `lifecycle` unexercised forever.
      child.kill('SIGTERM');
      const [code] = (await once(child, 'exit')) as [number | null];
      return code;
    },
  };
}
