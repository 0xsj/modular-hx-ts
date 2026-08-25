/**
 * An HTTP client that writes down what it did. **Test tooling, rung 3.**
 *
 * A passing test is nothing anyone can look at. This records every exchange —
 * method, path, headers, body, status, response and the `request_id` the server
 * assigned — and writes it to `artifacts/e2e-journal.md`, so the output of
 * `make e2e` is a document a person can read rather than a green tick.
 *
 * **Secrets are redacted on the way in, not on the way out.** A bearer token in
 * a committed artifact is a bearer token in the repository; `redact` below
 * replaces them with a stable alias (`<token:1>`), which keeps the journal
 * legible — the same alias appears everywhere the same token does, so *this
 * request used the session from step 2* is still visible.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Exchange {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  readonly requestHeaders: Record<string, string>;
  readonly requestBody?: unknown;
  readonly status: number;
  readonly responseHeaders: Record<string, string>;
  readonly responseBody: unknown;
  readonly requestId: string;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Anything that looks like a credential, replaced by a stable alias. */
class Aliases {
  #seen = new Map<string, string>();

  of(secret: string): string {
    const known = this.#seen.get(secret);
    if (known !== undefined) return known;
    const alias = `<token:${String(this.#seen.size + 1)}>`;
    this.#seen.set(secret, alias);
    return alias;
  }

  /** Replace every alias-worthy value found anywhere in a structure. */
  scrub<T>(value: T): T {
    if (typeof value === 'string') {
      let out: string = value;
      for (const [secret, alias] of this.#seen) {
        out = out.split(secret).join(alias);
      }
      return out as unknown as T;
    }
    if (Array.isArray(value)) {
      const items: unknown[] = value;
      return items.map((one) => this.scrub(one)) as unknown as T;
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, one]) => [
          key,
          this.scrub(one),
        ]),
      ) as unknown as T;
    }
    return value;
  }
}

/** What one exchange answered. Generic in the body the caller expects. */
export interface Answer<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Record<string, string>;
}

export interface ClientOptions {
  readonly base: string;
  /** Written when `finish()` is called. Relative to the repository root. */
  readonly artifact: string;
  readonly title: string;
}

export class Journal {
  readonly #base: string;
  readonly #artifact: string;
  readonly #title: string;
  readonly #aliases = new Aliases();
  readonly #exchanges: Exchange[] = [];
  #step = '';

  constructor(options: ClientOptions) {
    this.#base = options.base;
    this.#artifact = options.artifact;
    this.#title = options.title;
  }

  /** Name what the next few exchanges are for. Appears as a heading. */
  step(what: string): void {
    this.#step = what;
  }

  /** Register a value as a credential, so it never reaches the artifact raw. */
  secret(value: string): string {
    this.#aliases.of(value);
    return value;
  }

  /**
   * One exchange, recorded.
   *
   * Generic in the reply, and the cast is here rather than at every call site:
   * a journey that spelled `as UserReply` on every line would be a journey
   * nobody could read. What the body actually is stays the caller's claim —
   * which the assertions immediately check.
   */
  async send<T = unknown>(
    method: string,
    path: string,
    init: { headers?: Record<string, string>; body?: unknown } = {},
  ): Promise<Answer<T>> {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    const response = await fetch(`${this.#base}${path}`, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await response.text();
    let body: unknown = text;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        /* left as text — a non-JSON body is worth seeing verbatim */
      }
    }

    const responseHeaders = Object.fromEntries(response.headers.entries());
    this.#exchanges.push({
      step: this.#step,
      method,
      path,
      requestHeaders: this.#aliases.scrub(headers),
      ...(init.body === undefined
        ? {}
        : { requestBody: this.#aliases.scrub(init.body) }),
      status: response.status,
      responseHeaders: this.#aliases.scrub(responseHeaders),
      responseBody: this.#aliases.scrub(body),
      requestId: responseHeaders['x-request-id'] ?? '(none)',
    });

    return {
      status: response.status,
      body: body as T,
      headers: responseHeaders,
    };
  }

  get exchanges(): readonly Exchange[] {
    return this.#exchanges;
  }

  /**
   * Write the artifact.
   *
   * Scrubbed a second time here rather than only at capture: a token minted in
   * step 3 is not a secret yet when step 2 is recorded, and the alias table is
   * only complete at the end.
   */
  finish(): string {
    const path = resolve(ROOT, this.#artifact);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, this.#render(), 'utf8');
    return path;
  }

  #render(): string {
    const out: string[] = [
      `# ${this.#title}`,
      '',
      'Written by `make e2e` — every exchange the journey made against the real',
      'binary, in order. Credentials appear as stable aliases: the same token is',
      'the same `<token:n>` everywhere, so *this request reused that session* is',
      'still readable.',
      '',
      `${String(this.#exchanges.length)} exchanges.`,
      '',
    ];

    let step = '';
    for (const one of this.#exchanges) {
      if (one.step !== step) {
        step = one.step;
        out.push(`## ${step}`, '');
      }
      out.push(
        `### \`${one.method} ${one.path}\` → **${String(one.status)}**`,
        '',
        `\`request_id\` \`${one.requestId}\``,
        '',
        '```http',
        `${one.method} ${one.path} HTTP/1.1`,
        ...Object.entries(this.#aliases.scrub(one.requestHeaders)).map(
          ([key, value]) => `${key}: ${value}`,
        ),
        ...(one.requestBody === undefined
          ? []
          : [
              '',
              JSON.stringify(this.#aliases.scrub(one.requestBody), null, 2),
            ]),
        '```',
        '',
        '```http',
        `HTTP/1.1 ${String(one.status)}`,
        ...Object.entries(this.#aliases.scrub(one.responseHeaders)).map(
          ([key, value]) => `${key}: ${value}`,
        ),
        ...(one.responseBody === '' || one.responseBody === undefined
          ? []
          : [
              '',
              typeof one.responseBody === 'string'
                ? one.responseBody
                : JSON.stringify(
                    this.#aliases.scrub(one.responseBody),
                    null,
                    2,
                  ),
            ]),
        '```',
        '',
      );
    }
    return out.join('\n');
  }
}
