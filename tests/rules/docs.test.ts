import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allRules, DOC_RULES, type Violation } from './docs-rules.js';
import { SEMANTIC_RULES } from './semantic-rules.js';

/**
 * The N, D and R rules (../ENFORCEMENT.md), proved against fixtures.
 *
 * Same discipline as the architecture suite: on a repo with no notes and one
 * ADR most of these pass vacuously, so each rule also gets a repository root
 * built to trip it and nothing else. The real repository must satisfy all of
 * them, which is what keeps the rules honest as documents change.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtures = join(here, 'fixtures', 'docs');

const { LAYERS } = require(join(repoRoot, 'layers.cjs')) as {
  LAYERS: { id: string; modules: string[] }[];
};

const cruiser = require(join(repoRoot, '.dependency-cruiser.cjs')) as {
  forbidden: { name?: string }[];
};

/**
 * One half of D5's loop: the rule ids actually enforced in this repo. The S
 * ids are read off the rule set rather than listed here, so adding a rule and
 * forgetting to mandate it in an ADR fails rather than passes.
 */
const enforcedRules = [
  ...new Set(
    cruiser.forbidden.flatMap(
      (rule) => /^([SNDR]\d{1,2})-/.exec(rule.name ?? '')?.[1] ?? [],
    ),
  ),
  ...SEMANTIC_RULES,
  ...DOC_RULES,
];

const layerOf = new Map(
  LAYERS.flatMap((layer) => layer.modules.map((m) => [m, layer.id] as const)),
);
const builtModules = [...layerOf.keys()];

const check = (root: string): Violation[] =>
  allRules(root, layerOf, builtModules, enforcedRules);

/** fixture directory -> the rule it must trip. */
const CASES: readonly (readonly [fixture: string, rule: string])[] = [
  ['n1-module-without-note', 'N1'],
  ['n2-context-without-note', 'N2'],
  ['n3-note-missing-section', 'N3'],
  ['n4-dangling-wikilink', 'N4'],
  ['n5-note-cites-missing-path', 'N5'],
  ['n6-note-cites-missing-adr', 'N6'],
  ['n7-note-layer-mismatch', 'N7'],
  ['d1-adr-missing-section', 'D1'],
  ['d2-adr-bad-status', 'D2'],
  ['d4-adr-without-verification', 'D4'],
  ['d5-adr-without-enforced-by', 'D5'],
  ['d7-adr-reference-without-repo', 'D7'],
  ['r3-tree-describes-missing-file', 'R3'],
  ['r4-no-architecture-adr', 'R4'],
  ['r6-deferral-without-trigger', 'R6'],
  ['r7-binary-diagram', 'R7'],
];

describe('documentation rules', () => {
  it('this repository satisfies every rule', () => {
    // The one test here that is not about fixtures. It is also the one that
    // fires when a document drifts — which is the entire point of N5 and R3.
    expect(check(repoRoot).map((v) => v.message)).toEqual([]);
  });

  it('a conforming repository reports no violations', () => {
    expect(check(join(fixtures, 'clean')).map((v) => v.message)).toEqual([]);
  });

  it.each(CASES)('%s trips %s', (fixture, rule) => {
    const violations = check(join(fixtures, fixture));

    expect(
      violations.map((v) => v.rule),
      `fixture ${fixture} should trip ${rule}`,
    ).toContain(rule);
  });

  it.each(CASES)('%s trips nothing but %s', (fixture, rule) => {
    // A fixture that trips three rules proves none of them precisely.
    const others = [
      ...new Set(
        check(join(fixtures, fixture))
          .filter((v) => v.rule !== rule)
          .map((v) => v.message),
      ),
    ];

    expect(others, `fixture ${fixture} should trip exactly one rule`).toEqual(
      [],
    );
  });

  it('every implemented rule has a fixture proving it fires', () => {
    // DOC_RULES is the list this file's rules module claims to enforce; the
    // rules deliberately not implemented are recorded in docs/TREE.md.
    const proven = new Set(CASES.map(([, rule]) => rule));

    expect(
      DOC_RULES.filter((rule) => !proven.has(rule)),
      'each rule needs a fixture in tests/rules/fixtures/docs/ that trips it',
    ).toEqual([]);
  });
});
