import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cruise } from 'dependency-cruiser';
import type { ICruiseOptions, IForbiddenRuleType } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';

/**
 * The structural rules S1-S10 (../ENFORCEMENT.md), proved against fixtures.
 *
 * `make arch` cruises the real tree, which on an empty repo passes vacuously —
 * and a rule that has never fired is a rule nobody has tested. So every rule
 * also gets a tree built to trip it. A typo in a layer list or a regex fails
 * here, at the moment the rule is written, rather than silently never firing.
 *
 * Adding a rule means adding a fixture. The last test in this file enforces
 * that: no rule ships unproven.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const fixtures = join(here, 'fixtures', 'arch');

const config = require(join(repoRoot, '.dependency-cruiser.cjs')) as {
  forbidden: IForbiddenRuleType[];
  options: ICruiseOptions;
};

interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

/** Cruise one fixture tree with the real rule set and return its violations. */
async function cruiseFixture(name: string): Promise<Violation[]> {
  const result = await cruise(
    ['src'],
    {
      ...config.options,
      baseDir: join(fixtures, name),
      ruleSet: { forbidden: config.forbidden },
      outputType: 'json',
      validate: true,
    },
    undefined,
    undefined,
  );

  const output =
    typeof result.output === 'string'
      ? (JSON.parse(result.output) as { summary: { violations: Violation[] } })
      : (result.output as unknown as { summary: { violations: Violation[] } });

  return output.summary.violations;
}

/**
 * fixture directory -> the rule it must trip.
 *
 * One entry per rule in `.dependency-cruiser.cjs`. The fixture is named for
 * the rule so a failure reads as a sentence.
 */
const CASES: readonly (readonly [fixture: string, rule: string])[] = [
  ['s1-layer-ordering', 'S1-l0-kernel'],
  ['s1-runtime-imports-substrate', 'S1-l1-runtime'],
  ['s1-substrate-imports-capability', 'S1-l2-substrate'],
  ['s1-capability-imports-edge', 'S1-l3-capability'],
  ['s2-module-roots', 'S2-module-roots-contexts'],
  ['s2-module-roots-shared', 'S2-module-roots-shared'],
  ['s3-tooling-is-test-only', 'S3-tooling-is-test-only'],
  ['s5-shared-is-domain-free', 'S5-shared-is-domain-free'],
  ['s6-contexts-are-islands', 'S6-contexts-are-islands'],
  ['s7-domain-purity', 'S7-domain-purity'],
  ['s8-app-never-imports-adapters', 'S8-app-never-imports-adapters'],
  ['s8-adapters-never-meet', 'S8-adapters-never-meet'],
  ['s9-root-is-a-leaf', 'S9-root-is-a-leaf'],
  ['s10-vendor-confinement', 'S10-vendor-postgres'],
  ['s10-vendor-telemetry', 'S10-vendor-telemetry'],
  ['s10-vendor-mailer', 'S10-vendor-mailer'],
  ['s10-vendor-httpx', 'S10-vendor-httpx'],
  ['s10-vendor-logger', 'S10-vendor-logger'],
  ['no-circular', 'no-circular'],
];

describe('architecture rules', () => {
  it('a conforming tree reports no violations', async () => {
    // Guards against the opposite failure: rules so broad that correct code
    // trips them. This fixture imports L0 from L0, and errors from domain/ —
    // both legal, both easy to forbid by accident.
    await expect(cruiseFixture('clean')).resolves.toEqual([]);
  });

  it.each(CASES)('%s trips %s', async (fixture, rule) => {
    const violations = await cruiseFixture(fixture);

    expect(
      violations.map((v) => v.rule.name),
      `fixture ${fixture} should trip ${rule}`,
    ).toContain(rule);
  });

  it.each(CASES)('%s trips nothing but %s', async (fixture, rule) => {
    // A fixture that trips three rules proves none of them precisely.
    const violations = await cruiseFixture(fixture);
    const others = [
      ...new Set(
        violations.map((v) => v.rule.name).filter((name) => name !== rule),
      ),
    ];

    expect(others, `fixture ${fixture} should trip exactly one rule`).toEqual(
      [],
    );
  });

  it('every rule is named, so a failure can cite it', () => {
    const nameless = config.forbidden.filter(
      (rule) => rule.name === undefined || rule.name.length === 0,
    );

    expect(nameless, 'a rule nobody can cite is a rule nobody fixes').toEqual(
      [],
    );
  });

  it('every rule cites an ADR that exists (D5)', () => {
    const uncited = config.forbidden
      .filter((rule) => !/ADR \d{4}/.test(rule.comment ?? ''))
      .map((rule) => rule.name);

    expect(uncited, 'a rule with no ADR is a rule with no reason').toEqual([]);

    const missing = config.forbidden
      .flatMap((rule) => [...(rule.comment ?? '').matchAll(/ADR (\d{4})/g)])
      .map((match) => match[1] ?? '')
      .filter(
        (number) =>
          !existsSync(join(repoRoot, 'docs', 'decisions')) ||
          readdirSync(join(repoRoot, 'docs', 'decisions')).every(
            (file) => !file.startsWith(`${number}-`),
          ),
      );

    expect([...new Set(missing)], 'cited ADRs must exist').toEqual([]);
  });

  it('every rule has a fixture proving it fires', () => {
    const proven = new Set(CASES.map(([, rule]) => rule));
    const unproven = config.forbidden
      .flatMap((rule) => (rule.name === undefined ? [] : [rule.name]))
      .filter((name) => !proven.has(name));

    expect(
      unproven,
      'each rule needs a fixture in tests/rules/fixtures/ that trips it',
    ).toEqual([]);
  });
});
