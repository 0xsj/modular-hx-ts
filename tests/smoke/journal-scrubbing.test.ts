/**
 * **The journal scrubs both directions.** A regression guard, not a unit test.
 *
 * The hole this exists for was described by the blueprint that found it better
 * than it could be described again:
 *
 * > *I added scrubbing when a bearer token turned up in a response — and the
 * > fix looked complete because the thing it was written for stopped appearing.
 * > Nobody looked the other way.*
 *
 * Every password a journey types went into the artifact in the clear, in a file
 * whose entire purpose is being handed to somebody. The values were fixtures,
 * so nothing leaked — and that is not the point: **the mechanism is what
 * ships**, and the first person to run a journey against an environment with a
 * real credential in it inherits whatever the scrubber covers.
 *
 * So this asserts the mechanism rather than any particular journey, and it
 * asserts the direction that was missing first.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Journal } from '../testx/journal.js';

const SECRET = 'hunter2-not-a-real-password';
const BEARER = 'aaaabbbbccccddddeeeeffff00001111';

/** A journal over a server that echoes what it is sent. */
function recorded(): { journal: Journal; artifact: string } {
  const artifact = `artifacts/scrubbing-${String(process.pid)}.md`;
  return {
    journal: new Journal({ base: '', artifact, title: 'scrubbing' }),
    artifact,
  };
}

describe('the journal', () => {
  it('aliases a value under a sensitive field name in a REQUEST body', () => {
    // The direction that was missing. Nothing is registered by hand here —
    // `redact` owns the vocabulary, and the journal harvests from it.
    const { journal } = recorded();

    const rendered = render(journal, {
      requestBody: { email: 'ada@example.test', password: SECRET },
      responseBody: { id: 'u1' },
    });

    expect(rendered).not.toContain(SECRET);
    expect(rendered).toMatch(/<token:\d+>/);
  });

  it('aliases one in a RESPONSE body, which is where the fix started', () => {
    const { journal } = recorded();

    const rendered = render(journal, {
      requestBody: { email: 'ada@example.test' },
      responseBody: { access_token: BEARER },
    });

    expect(rendered).not.toContain(BEARER);
  });

  it('aliases an authorization header in both directions', () => {
    const { journal } = recorded();

    const rendered = render(journal, {
      requestHeaders: { authorization: `Bearer ${BEARER}` },
      responseHeaders: { 'set-cookie': `session=${SECRET}` },
      responseBody: {},
    });

    expect(rendered).not.toContain(BEARER);
    expect(rendered).not.toContain(SECRET);
  });

  it('masks a value in an EARLIER exchange once it is seen later', () => {
    // The alias table only grows, so the render pass is what decides — a
    // secret first recognised in step 9 is masked in step 2's body too. A
    // non-JSON body used to bypass this and be rendered verbatim.
    const { journal } = recorded();

    const rendered = render(
      journal,
      { requestBody: { note: SECRET }, responseBody: 'ok' },
      { requestBody: { password: SECRET }, responseBody: {} },
    );

    expect(rendered).not.toContain(SECRET);
  });

  it('keeps the artifact READABLE rather than redacting it', () => {
    // A transcript full of `[redacted]` is documentation; one that keeps its
    // shape is a tool. The same value is the same alias everywhere, so *this
    // request reused the session from step 2* is still visible.
    const { journal } = recorded();

    const rendered = render(
      journal,
      { requestBody: { password: SECRET }, responseBody: {} },
      { requestBody: { password: SECRET }, responseBody: {} },
    );

    const aliases = [...rendered.matchAll(/<token:(\d+)>/g)].map(
      (match) => match[1],
    );
    expect(new Set(aliases).size).toBe(1);
    expect(rendered).not.toContain('[redacted]');
  });
});

interface Exchange {
  readonly requestHeaders?: Record<string, string>;
  readonly requestBody?: unknown;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody: unknown;
}

/**
 * Record exchanges without a server, then render.
 *
 * `send` needs a socket; this drives the same alias machinery through the
 * public surface it exposes for exactly this reason — a test that reached into
 * the private table would pass while the wiring in `send` was wrong, which is
 * the shape of the bug it is guarding.
 */
function render(journal: Journal, ...exchanges: readonly Exchange[]): string {
  for (const one of exchanges) {
    journal.record({
      method: 'POST',
      path: '/v1/example',
      requestHeaders: one.requestHeaders ?? {},
      ...(one.requestBody === undefined
        ? {}
        : { requestBody: one.requestBody }),
      status: 200,
      responseHeaders: one.responseHeaders ?? {},
      responseBody: one.responseBody,
      requestId: 'r1',
    });
  }
  const path = journal.finish();
  const rendered = readFileSync(path, 'utf8');
  return rendered;
}
