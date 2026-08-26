/**
 * An HTTP client that writes down what it did. **Test tooling, rung 3.**
 *
 * A passing test is nothing anyone can look at. This records every exchange —
 * method, path, headers, body, status, response and the `request_id` the server
 * assigned — and writes it to `artifacts/e2e-journal.md`, so the output of
 * `make e2e` is a document a person can read rather than a green tick.
 *
 * **Both directions, and the gap was one of them.** Scrubbing was added when a
 * bearer token turned up in a *response*, and the fix looked complete because
 * the thing it was written for stopped appearing. Nobody looked the other way:
 * every password the journey typed went into the artifact in the clear, in a
 * file whose entire purpose is being handed to somebody.
 *
 * Two mechanisms now, and the second is the one that does not need remembering:
 *
 * - **An alias table.** A caller registers a value with `secret()` and every
 *   occurrence becomes a stable alias — `<token:1>` — so *this request reused
 *   the session from step 2* stays readable. Aliases rather than `[redacted]`
 *   for exactly that reason: a transcript full of redactions is documentation,
 *   and one that keeps its shape is a tool.
 * - **Field names, harvested automatically.** Anything `redact` considers
 *   sensitive — `password`, `token`, `secret`, `authorization` — is registered
 *   the moment it is seen, in a request body or a response body alike. The
 *   journey no longer has to remember, which is what let the hole open: a
 *   password invented inline three tests later was never registered anywhere.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { isSensitiveKey } from '../../src/shared/redact/index.js';
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

  /**
   * Register every value under a sensitive field name, anywhere in a structure.
   *
   * **The half that needs no discipline.** `redact` already owns the question
   * *is this field name a secret*, and reusing its answer is what keeps the two
   * from disagreeing. Registering rather than replacing means the value is then
   * aliased **everywhere it appears**, including in exchanges recorded before
   * it was first seen — a password sent in step 9 is masked in step 2's body
   * too, because the render pass runs over the whole journal at the end.
   */
  harvest(value: unknown): void {
    if (Array.isArray(value)) {
      for (const one of value) this.harvest(one);
      return;
    }
    if (value === null || typeof value !== 'object') return;

    for (const [key, one] of Object.entries(value as Record<string, unknown>)) {
      if (typeof one === 'string' && one !== '' && isSensitiveKey(key)) {
        this.of(one);
        continue;
      }
      this.harvest(one);
    }
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

    // **Before anything is recorded, and on the way in.** A body is harvested
    // whether it is going out or coming back; headers too, which is where an
    // `authorization` lives.
    this.#aliases.harvest(init.body);
    this.#aliases.harvest(headers);

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

    this.record({
      method,
      path,
      requestHeaders: headers,
      ...(init.body === undefined ? {} : { requestBody: init.body }),
      status: response.status,
      responseHeaders,
      responseBody: body,
      requestId: responseHeaders['x-request-id'] ?? '(none)',
    });

    return {
      status: response.status,
      body: body as T,
      headers: responseHeaders,
    };
  }

  /**
   * Write one exchange down. **The only path into the journal**, so `send` and
   * anything testing the scrubber exercise the same wiring.
   *
   * Public for that reason: a test reaching into the private alias table would
   * pass while this method's harvesting was wrong, which is precisely the shape
   * of the bug it guards — a scrubber that works and is not called.
   */
  record(exchange: Omit<Exchange, 'step'>): void {
    // **Both directions, before anything is recorded.** Field names are
    // harvested from a request body and a response body alike, and from the
    // headers on each side, which is where an `authorization` lives.
    this.#aliases.harvest(exchange.requestBody);
    this.#aliases.harvest(exchange.requestHeaders);
    this.#aliases.harvest(exchange.responseBody);
    this.#aliases.harvest(exchange.responseHeaders);

    this.#exchanges.push({
      step: this.#step,
      ...exchange,
      requestHeaders: this.#aliases.scrub(exchange.requestHeaders),
      ...(exchange.requestBody === undefined
        ? {}
        : { requestBody: this.#aliases.scrub(exchange.requestBody) }),
      responseHeaders: this.#aliases.scrub(exchange.responseHeaders),
      responseBody: this.#aliases.scrub(exchange.responseBody),
    });
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
