import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allSemanticRules,
  m2TimeIsInjected,
  SEMANTIC_RULES,
} from './semantic-rules.js';

/**
 * The M rules, proved against fixtures — same discipline as the S and N suites.
 * The repository must satisfy every one, and each rule gets a tree built to
 * trip it and nothing else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtures = join(here, 'fixtures', 'semantic');

const CASES: readonly (readonly [fixture: string, rule: string])[] = [
  ['m2-direct-clock-call', 'M2'],
  ['i5-direct-entropy', 'I5'],
  ['m13-wall-clock-duration', 'M13'],
  ['m6-event-names-wrong-context', 'M6'],
  ['m9-classification-assertion', 'M9'],
  ['m4-command-without-subject', 'M4'],
  ['m3-query-without-tenant', 'M3'],
];

describe('semantic rules', () => {
  it('this repository satisfies every rule', () => {
    expect(allSemanticRules(repoRoot).map((v) => v.message)).toEqual([]);
  });

  it('a conforming tree reports no violations', () => {
    // Includes `new Date('2026-01-01…')`, which names an instant rather than
    // reading one, and the clock module itself, which is the exemption.
    expect(allSemanticRules(join(fixtures, 'clean'))).toEqual([]);
  });

  it.each(CASES)('%s trips %s', (fixture, rule) => {
    const violations = allSemanticRules(join(fixtures, fixture));

    expect(violations.map((v) => v.rule)).toContain(rule);
  });

  it('M2 catches all three ways to read the platform clock', () => {
    const messages = m2TimeIsInjected(
      join(fixtures, 'm2-direct-clock-call'),
    ).map((v) => v.message);

    expect(messages).toHaveLength(3);
    expect(messages.join('\n')).toContain('new Date()');
    expect(messages.join('\n')).toContain('Date.now()');
    expect(messages.join('\n')).toContain('performance.now()');
  });

  it('names the file and line, so a failure is actionable', () => {
    const [first] = m2TimeIsInjected(join(fixtures, 'm2-direct-clock-call'));

    expect(first?.message).toMatch(/^src\/shared\/widget\/index\.ts:\d+ /);
  });

  it('I5 catches every way to reach entropy directly', () => {
    const messages = allSemanticRules(join(fixtures, 'i5-direct-entropy'))
      .filter((v) => v.rule === 'I5')
      .map((v) => v.message)
      .join('\n');

    expect(messages).toContain('Math.random()');
    expect(messages).toContain('crypto.getRandomValues()');
    expect(messages).toContain('imports randomBytes from node:crypto');
  });

  it('every rule has a fixture proving it fires', () => {
    const proven = new Set(CASES.map(([, rule]) => rule));

    expect(SEMANTIC_RULES.filter((rule) => !proven.has(rule))).toEqual([]);
  });
});
