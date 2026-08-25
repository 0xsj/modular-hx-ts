import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

const { LAYERS } = require(join(repoRoot, 'layers.cjs')) as {
  LAYERS: { id: string; modules: string[] }[];
};

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
  ['s3-testkit-is-test-only', 'S3-tooling-is-test-only'],
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

/**
 * S1's map must be **total** — `../../ENFORCEMENT.md` S1, amended.
 *
 * > Every module in the tree resolves to a layer, or the test fails on the
 * > module — never skips it.
 *
 * A module absent from `layers.cjs` is not un-ordered, it is **unchecked**:
 * `inModules()` builds each S1 rule from the named list, so a module nobody
 * named appears in no rule, matches no `from` and no `to`, and passes in
 * silence. There is nothing to compare it against and no failure to read.
 *
 * A sibling found this the expensive way: `edge`, the floor of L4 that every
 * other edge module imports, had never been in its map at all — so the one
 * module the layer is built on was the one module S1 did not constrain, and it
 * had passed every run since it was written.
 *
 * **A test rather than an inspection**, because the failure mode is silence and
 * an inspection is a thing somebody remembers to do. A new module is two edits
 * from now on: the code, and its row here.
 */
describe('S1 — the layer map is total', () => {
  const assigned = new Set(LAYERS.flatMap((layer) => layer.modules));
  const onDisk = readdirSync(join(repoRoot, 'src', 'shared'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  it('assigns every module under src/shared/ to a layer', () => {
    const unassigned = onDisk.filter((module) => !assigned.has(module));

    expect(
      unassigned,
      'these modules exist and S1 does not constrain them: add a row to layers.cjs',
    ).toEqual([]);
  });

  it.each([
    ['edge', 'L4'],
    ['httpx', 'L4'],
    ['httproute', 'L4'],
    ['idempotency', 'L4'],
    ['ratelimit', 'L4'],
    ['conditional', 'L4'],
  ])('places %s at %s', (module, tier) => {
    // Named individually because the collection asked for these six by name,
    // and because a totality check passes just as happily with a module in the
    // wrong tier.
    const found = LAYERS.find((layer) => layer.modules.includes(module));

    expect(found?.id, `${module} is not at ${tier}`).toBe(tier);
  });

  it('does not name a module that no longer exists, except a declared one', () => {
    // The reverse direction, and it is **not** an error on its own: a row may
    // legitimately precede its directory — `openapi` is parked in
    // `docs/TREE.md` with its layer already decided. What is an error is a row
    // for a module that is neither on disk nor unticked in the tree, which is
    // what a rename leaves behind.
    const tree = readFileSync(join(repoRoot, 'docs', 'TREE.md'), 'utf8');
    const stale = [...assigned].filter(
      (module) =>
        !onDisk.includes(module) &&
        !tree.includes(`- [ ] \`src/shared/${module}/\``),
    );

    expect(stale, 'rows in layers.cjs pointing at nothing').toEqual([]);
  });
});

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

/**
 * `S10` matches a package however the installer laid it out.
 *
 * A fixture cannot prove this half: fixture trees have no `node_modules`, so
 * every import in one is *unresolvable*, and an unresolvable import exercises
 * only the first of the three forms below. The rule therefore passed vacuously
 * for any package actually installed — which nothing was, until `pg`.
 *
 * These assert the pattern directly, which is the only way to cover the layout
 * this repository really produces.
 */
describe('S10 matches an installed package, not just an absent one', () => {
  const rule = config.forbidden.find((r) => r.name === 'S10-vendor-postgres');
  // `to.path` is typed as a union that includes string[] and RegExp; this rule
  // set only ever produces a string, and the assertion below fails loudly if
  // that ever stops being true.
  const pattern = (rule as { to?: { path?: unknown } } | undefined)?.to?.path;

  it('is a single pattern, as the rest of this block assumes', () => {
    expect(typeof pattern).toBe('string');
  });

  const matches = (path: string): boolean =>
    new RegExp(String(pattern)).test(path);

  it('matches the unresolvable form — the package is not installed', () => {
    expect(matches('pg')).toBe(true);
  });

  it('matches npm and yarn’s flat layout', () => {
    expect(matches('node_modules/pg/lib/index.js')).toBe(true);
  });

  it('matches pnpm’s layout, which is what this repo produces', () => {
    // The one the original pattern missed, because `.pnpm` sits between
    // `node_modules/` and the package name. Every S10 rule was inert for any
    // installed package until this was fixed.
    expect(
      matches('node_modules/.pnpm/pg@8.23.0/node_modules/pg/esm/index.mjs'),
    ).toBe(true);
  });

  it('does not match a package that merely starts with the same letters', () => {
    expect(matches('node_modules/pgadmin/index.js')).toBe(false);
    expect(matches('pgbouncer')).toBe(false);
  });
});
