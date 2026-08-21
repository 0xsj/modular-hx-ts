import { describe as suite, expect, it } from 'vitest';
import {
  buildInfo,
  describe,
  shortCommit,
  UNKNOWN_COMMIT,
  UNKNOWN_VERSION,
  userAgent,
  versionPayload,
} from './index.js';

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

const stamped = buildInfo({
  name: 'modular-hx-ts',
  version: '1.4.0',
  commit: SHA,
  builtAt: '2026-01-01T00:00:00.000Z',
});

suite('buildInfo', () => {
  it('degrades to honest placeholders when nothing was stamped', () => {
    // A local build, or a container built outside CI.
    const info = buildInfo();

    expect(info.name).toBe('unknown');
    expect(info.version).toBe(UNKNOWN_VERSION);
    expect(info.commit).toBe(UNKNOWN_COMMIT);
    expect(info.builtAt).toBeUndefined();
    expect(info.dirty).toBe(false);
  });

  it('never throws, whatever the build put there', () => {
    // Invariant I9: an observability concern fails open. Refusing to boot
    // because a version string was malformed turns a cosmetic defect into an
    // outage, during the rollback that was meant to fix something else.
    const garbage = [
      {},
      { version: '   ' },
      { commit: '' },
      { commit: 'not-a-sha' },
      { builtAt: 'yesterday' },
      { dirty: 'maybe' },
      { name: '', version: '', commit: '', builtAt: '' },
    ];

    for (const raw of garbage) {
      expect(() => buildInfo(raw)).not.toThrow();
    }
  });

  it('treats an unsubstituted placeholder as missing', () => {
    // `$COMMIT` reaching production means the build template did not run, and
    // reporting it verbatim is worse than admitting the value is unknown.
    expect(buildInfo({ commit: '$COMMIT' }).commit).toBe(UNKNOWN_COMMIT);
    expect(buildInfo({ commit: '${GIT_SHA}' }).commit).toBe(UNKNOWN_COMMIT);
  });

  it('accepts a full or abbreviated sha, and lowercases it', () => {
    expect(buildInfo({ commit: SHA }).commit).toBe(SHA);
    expect(buildInfo({ commit: SHA.toUpperCase() }).commit).toBe(SHA);
    expect(buildInfo({ commit: 'a1b2c3d' }).commit).toBe('a1b2c3d');
  });

  it('rejects a sha that is the wrong shape', () => {
    for (const commit of [
      'a1b2c3',
      `${SHA}0`,
      'g1b2c3d',
      'a1b2c3d '.repeat(2),
    ]) {
      expect(buildInfo({ commit }).commit).toBe(UNKNOWN_COMMIT);
    }
  });

  it('trims surrounding whitespace, which shell substitution leaves behind', () => {
    const info = buildInfo({ name: ' modular-hx-ts\n', version: ' 1.4.0 ' });

    expect(info.name).toBe('modular-hx-ts');
    expect(info.version).toBe('1.4.0');
  });

  it('parses a build time, and drops one it cannot', () => {
    expect(stamped.builtAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(buildInfo({ builtAt: 'yesterday' }).builtAt).toBeUndefined();
    expect(buildInfo({ builtAt: '' }).builtAt).toBeUndefined();
  });

  it('reads dirty as a boolean or as the string a shell produces', () => {
    expect(buildInfo({ dirty: true }).dirty).toBe(true);
    expect(buildInfo({ dirty: 'true' }).dirty).toBe(true);
    expect(buildInfo({ dirty: false }).dirty).toBe(false);
    expect(buildInfo({ dirty: 'false' }).dirty).toBe(false);
    expect(buildInfo({ dirty: 'yes' }).dirty).toBe(false);
  });
});

suite('formatting', () => {
  it('shortens a commit the way everyone quotes one', () => {
    expect(shortCommit(stamped)).toBe('a1b2c3d');
    expect(shortCommit(stamped, 12)).toBe('a1b2c3d4e5f6');
  });

  it('does not shorten a commit it does not have', () => {
    expect(shortCommit(buildInfo())).toBe(UNKNOWN_COMMIT);
  });

  it('describes a build in one line', () => {
    expect(describe(stamped)).toBe(
      'modular-hx-ts 1.4.0 (a1b2c3d, built 2026-01-01T00:00:00.000Z)',
    );
  });

  it('says when a build came from a dirty tree', () => {
    // The detail that explains why the deployed behaviour does not match the
    // commit somebody is reading.
    const dirty = buildInfo({
      ...{ name: 'x', version: '1.0.0', commit: SHA },
      dirty: true,
    });

    expect(describe(dirty)).toContain('dirty');
  });

  it('describes an unstamped build without pretending', () => {
    expect(describe(buildInfo())).toBe('unknown dev (unknown)');
  });

  it('builds a User-Agent in RFC 9110 product form', () => {
    expect(userAgent(stamped)).toBe('modular-hx-ts/1.4.0 (+a1b2c3d)');
  });
});

suite('versionPayload', () => {
  it('is plain JSON with an explicit ISO string', () => {
    // The shape is a public API. A Date would serialize differently depending
    // on who does it, so the conversion happens exactly once, here.
    expect(versionPayload(stamped)).toEqual({
      name: 'modular-hx-ts',
      version: '1.4.0',
      commit: SHA,
      dirty: false,
      builtAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('omits a build time it does not have, rather than sending null', () => {
    expect(versionPayload(buildInfo())).toEqual({
      name: 'unknown',
      version: UNKNOWN_VERSION,
      commit: UNKNOWN_COMMIT,
      dirty: false,
    });
  });

  it('survives JSON unchanged', () => {
    const payload = versionPayload(stamped);

    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });
});
