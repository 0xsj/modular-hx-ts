/* eslint-disable @typescript-eslint/restrict-template-expressions --
   This suite exercises the accidental-stringification paths the module exists
   to make safe. Refusing to interpolate a Secret here would test something
   else — the point is that the careless version is harmless. */
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  isSecret,
  mask,
  REDACTED,
  redactKeys,
  secret,
  SENSITIVE_KEYS,
} from './index.js';

const TOKEN = 'sk_live_51H8yQwErTyUiOpAsDfGh';

describe('a secret cannot print itself', () => {
  const held = secret(TOKEN);

  it('does not leak through a template literal', () => {
    expect(`bearer ${held}`).toBe(`bearer ${REDACTED}`);
  });

  it('does not leak through String', () => {
    expect(String(held)).toBe(REDACTED);
    expect(held.toString()).toBe(REDACTED);
  });

  it('does not leak through JSON', () => {
    expect(JSON.stringify(held)).toBe(`"${REDACTED}"`);
    expect(JSON.stringify({ authorization: held })).toBe(
      `{"authorization":"${REDACTED}"}`,
    );
  });

  it('does not leak through console.log', () => {
    // util.inspect is what console.log actually calls, and it ignores toString
    // entirely — this is the escape hatch most implementations miss.
    expect(inspect(held)).toBe(REDACTED);
    expect(inspect({ credentials: held })).toContain(REDACTED);
    expect(inspect({ credentials: held })).not.toContain('sk_live');
  });

  it('does not leak through concatenation or coercion', () => {
    expect(`${held}`).toBe(REDACTED);
    expect([held].join('')).toBe(REDACTED);
    expect(`${String(held)}!`).toBe(`${REDACTED}!`);
  });

  it('does not leak through the shapes that enumerate properties', () => {
    // The value lives in a #private field, which none of these can reach.
    expect(Object.keys(held)).toEqual([]);
    expect(Object.values(held)).toEqual([]);
    expect(JSON.stringify({ ...held })).toBe('{}');
    expect(inspect({ ...held })).not.toContain('sk_live');
  });

  it('does not leak when nested anywhere in a logged object', () => {
    const payload = {
      user: { email: 'ada@example.com', session: { token: held } },
      items: [held],
    };

    const printed = `${JSON.stringify(payload)}${inspect(payload)}`;

    expect(printed).not.toContain('sk_live');
  });

  it('still gives the value up when explicitly asked', () => {
    // Verbose and greppable on purpose: every call site is a place a secret
    // enters plain memory, and one search should find all of them.
    expect(held.expose()).toBe(TOKEN);
  });

  it('wraps anything, not just strings', () => {
    const key = secret(new Uint8Array([1, 2, 3]));

    expect(String(key)).toBe(REDACTED);
    expect(key.expose()).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('is recognizable', () => {
    expect(isSecret(held)).toBe(true);
    expect(isSecret(TOKEN)).toBe(false);
    expect(isSecret({ expose: () => TOKEN })).toBe(false);
  });
});

describe('redactKeys', () => {
  it('replaces values under sensitive keys', () => {
    const scrubbed = redactKeys({
      email: 'ada@example.com',
      password: 'correct horse battery staple',
      apiKey: TOKEN,
    });

    expect(scrubbed).toEqual({
      email: 'ada@example.com',
      password: REDACTED,
      apiKey: REDACTED,
    });
  });

  it('matches case-insensitively and as a substring', () => {
    // Headers and DTOs name the same thing five different ways.
    const scrubbed = redactKeys({
      Authorization: 'Bearer x',
      'X-Api-Key': TOKEN,
      userPassword: 'x',
      refresh_token: 'x',
      SessionId: 'x',
    }) as Record<string, unknown>;

    for (const value of Object.values(scrubbed)) {
      expect(value).toBe(REDACTED);
    }
  });

  it('over-matches rather than under-matches, deliberately', () => {
    // A redacted metric is a nuisance. A logged bearer token is an incident.
    expect(redactKeys({ tokenCount: 12 })).toEqual({ tokenCount: REDACTED });
  });

  it('reaches into nested objects and arrays', () => {
    const scrubbed = redactKeys({
      users: [{ name: 'Ada', password: 'x' }],
      config: { db: { host: 'localhost', secret: 'x' } },
    });

    expect(JSON.stringify(scrubbed)).not.toContain('"x"');
    expect(JSON.stringify(scrubbed)).toContain('localhost');
  });

  it('replaces a wrapped secret wherever it appears', () => {
    expect(redactKeys({ anything: secret(TOKEN) })).toEqual({
      anything: REDACTED,
    });
  });

  it('does not mutate what it was given', () => {
    // It is called on the way to a log, and a scrubber that damaged the value
    // being processed would be far worse than the leak.
    const original = { password: 'x', nested: { token: 'y' } };
    const copy = structuredClone(original);

    redactKeys(original);

    expect(original).toEqual(copy);
  });

  it('passes a value that is not a bag of fields straight through', () => {
    // Traversal rebuilds an object from its enumerable properties. A Date has
    // none, so it came out as `{}` — in a log line, where the timestamp was
    // the point. Same class of bug as the Error case below.
    const at = new Date('2026-01-01T00:00:00.000Z');
    const tags = new Map([['a', 1]]);
    const bytes = new Uint8Array([1, 2, 3]);

    const scrubbed = redactKeys({ at, tags, bytes }) as Record<string, unknown>;

    expect(scrubbed['at']).toBe(at);
    expect(scrubbed['tags']).toBe(tags);
    expect(scrubbed['bytes']).toBe(bytes);
  });

  it('still traverses a null-prototype object, which headers often are', () => {
    const headers = Object.assign(Object.create(null) as object, {
      'X-Api-Key': 'sk_live_51H8yQ',
      accept: 'application/json',
    });

    const scrubbed = redactKeys(headers) as Record<string, unknown>;

    expect(scrubbed['X-Api-Key']).toBe(REDACTED);
    expect(scrubbed['accept']).toBe('application/json');
  });

  it('passes an Error through instead of dismantling it', () => {
    // Rebuilding an Error from its enumerable properties drops `message` and
    // `stack`, which are not enumerable, and strips the prototype. A logger
    // downstream then loses the whole point of the line it was writing.
    const cause = new Error('connection refused');
    const scrubbed = redactKeys({ err: cause }) as { err: unknown };

    expect(scrubbed.err).toBe(cause);
    expect(scrubbed.err).toBeInstanceOf(Error);
    expect((scrubbed.err as Error).message).toBe('connection refused');
  });

  it('still redacts a Secret held inside an error’s details', () => {
    // Errors pass through, so a secret in one must protect itself.
    const held = secret('sk_live_51H8yQwErTyUi');
    const scrubbed = redactKeys({ err: { details: { apiKey: held } } });

    expect(JSON.stringify(scrubbed)).not.toContain('sk_live');
  });

  it('survives a cycle', () => {
    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;

    expect(redactKeys(node)).toEqual({ name: 'root', self: '[circular]' });
  });

  it('leaves primitives and empty structures alone', () => {
    expect(redactKeys(null)).toBeNull();
    expect(redactKeys(42)).toBe(42);
    expect(redactKeys('plain')).toBe('plain');
    expect(redactKeys([])).toEqual([]);
    expect(redactKeys({})).toEqual({});
  });

  it('takes a custom fragment list', () => {
    const scrubbed = redactKeys({ password: 'x', pin: '1234' }, ['pin']);

    expect(scrubbed).toEqual({ password: 'x', pin: REDACTED });
  });

  it('names every fragment in lowercase, or the match never fires', () => {
    // isSensitive lowercases the key, not the fragment.
    for (const fragment of SENSITIVE_KEYS) {
      expect(fragment).toBe(fragment.toLowerCase());
    }
  });
});

describe('a short fragment is a word, not a substring', () => {
  it('still redacts a PAN in every convention it is written in', () => {
    // Separators are the gap that matters: a list written in one convention
    // silently misses the others.
    expect(redactKeys({ pan: '4111111111111111' })).toEqual({ pan: REDACTED });
    expect(redactKeys({ card_pan: '4111' })).toEqual({ card_pan: REDACTED });
    expect(redactKeys({ cardPan: '4111' })).toEqual({ cardPan: REDACTED });
    expect(redactKeys({ 'X-PAN': '4111' })).toEqual({ 'X-PAN': REDACTED });
  });

  it('leaves the words that merely contain it alone', () => {
    // `span` was redacted in a real telemetry log line before this rule
    // existed. At three characters the substring rule stops being a small
    // over-match and starts being a wrong one.
    expect(
      redactKeys({ span: 'self check', panel: 'left', expand: true }),
    ).toEqual({ span: 'self check', panel: 'left', expand: true });
  });

  it('applies the same rule to ssn', () => {
    expect(redactKeys({ user_ssn: '000', lesson: 'one' })).toEqual({
      user_ssn: REDACTED,
      lesson: 'one',
    });
  });

  it('keeps matching long fragments anywhere in the key', () => {
    // The deliberate over-match: a redacted metric is a nuisance, a logged
    // bearer token is an incident.
    expect(redactKeys({ tokenCount: 3, oauthState: 'x' })).toEqual({
      tokenCount: REDACTED,
      oauthState: REDACTED,
    });
  });
});

describe('mask', () => {
  it('reveals the last few characters for the support case', () => {
    expect(mask(TOKEN)).toBe(`${REDACTED}DfGh`);
    expect(mask('4111111111111111')).toBe(`${REDACTED}1111`);
  });

  it('hides a value too short to mask meaningfully', () => {
    // A four-character PIN masked to its last two is not masked.
    expect(mask('1234')).toBe(REDACTED);
    expect(mask('12345678')).toBe(REDACTED);
    expect(mask('')).toBe(REDACTED);
  });

  it('takes a reveal length, and refuses a negative one', () => {
    expect(mask(TOKEN, 2)).toBe(`${REDACTED}Gh`);
    expect(mask(TOKEN, -1)).toBe(REDACTED);
  });
});
