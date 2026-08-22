/**
 * Structural rules S1-S10, as import-graph rules.
 *
 * Specified in ../ENFORCEMENT.md; mandated by docs/decisions/0001-architecture
 * (rule D5). Every rule below names its id, and every message names the file
 * and the rule, because a failure nobody can act on is a failure nobody fixes.
 *
 * Rules are anchored on `src/` and cruised with a `baseDir`, so one rule set
 * governs both the real tree and the fixture trees under
 * `tests/rules/fixtures/` that prove each rule actually fires.
 */

// The layer table and the vendor SDK table are one source of truth, shared with
// the docs test so a module's layer is stated twice and must agree (N7).
const { LAYERS, VENDOR_SDKS } = require('./layers.cjs');

// --- helpers ---------------------------------------------------------------

/** Path pattern matching any file inside one of the named shared modules. */
const inModules = (modules) => `^src/shared/(${modules.join('|')})(/|$)`;

/** Matches a package by resolved path or by bare, unresolved specifier. */
const pkg = (patterns) => `^(node_modules/)?(${patterns.join('|')})(/|$)`;

// --- S1 · layer ordering ---------------------------------------------------

const s1 = LAYERS.flatMap((layer, index) => {
  const above = LAYERS.slice(index + 1);
  if (above.length === 0) return [];
  return [
    {
      name: `S1-${layer.id.toLowerCase()}-${layer.name}`,
      comment:
        `S1: ${layer.id} ${layer.name} may import only ${layer.id} and below. ` +
        `Higher layers are ${above.map((l) => l.id).join(', ')}. ` +
        'When a module does not obviously belong to a layer, it is usually two modules.',
      severity: 'error',
      from: { path: inModules(layer.modules) },
      to: { path: inModules(above.flatMap((l) => l.modules)) },
    },
  ];
});

// --- S10 · vendor confinement ----------------------------------------------

const s10 = VENDOR_SDKS.map(({ owner, packages }) => ({
  name: `S10-vendor-${owner}`,
  comment:
    `S10: ${packages.join(', ')} belongs to src/shared/${owner} and is imported ` +
    'nowhere else. Wrap it, or the SDK becomes the interface.',
  severity: 'error',
  from: { path: '^src/', pathNot: `^src/shared/${owner}(/|$)` },
  to: { path: pkg(packages) },
}));

/**
 * D5 — every rule names the ADR that mandates it. Applied to the whole set
 * rather than written out per rule, so a rule cannot be added without one.
 * dependency-cruiser prints `comment` on a violation, which puts the citation
 * in the failure message where somebody will actually read it.
 */
const mandatedBy = (adr, rules) =>
  rules.map((rule) => ({ ...rule, comment: `${rule.comment} (${adr})` }));

// ---------------------------------------------------------------------------

module.exports = {
  forbidden: mandatedBy('ADR 0001', [
    ...s1,

    {
      name: 'S2-module-roots-shared',
      comment:
        'S2: a module is reached through its root, never an adapter subpackage. ' +
        'postgres is an implementation detail of the module that uses it.',
      severity: 'error',
      from: {
        path: '^src/shared/([^/]+)/',
        // ../ENFORCEMENT.md S2 exempts test files: a test may reach a peer
        // module's contract suite or testkit, which is the mechanism I2 and
        // §4's builder require. Shipping code still goes through the root.
        pathNot: '\\.(test|contract|testkit)\\.ts$',
      },
      to: {
        path: '^src/shared/[^/]+/.+',
        pathNot: ['^src/shared/$1/', '^src/shared/[^/]+/index\\.ts$'],
      },
    },
    {
      name: 'S2-module-roots-contexts',
      comment:
        'S2: a context reaches a shared module through its root, never through ' +
        'one of its adapters.',
      severity: 'error',
      from: {
        path: '^src/contexts/',
        pathNot: '\\.(test|contract|testkit)\\.ts$',
      },
      to: {
        path: '^src/shared/[^/]+/.+',
        pathNot: '^src/shared/[^/]+/index\\.ts$',
      },
    },

    {
      name: 'S3-tooling-is-test-only',
      comment:
        'S3: test tooling is imported by test files and by other test tooling, ' +
        'and by nothing that ships. Two suffixes carry it: `.contract.ts` is a ' +
        "port's one suite that every adapter passes, and `.testkit.ts` is a " +
        'builder for a type whose constructors are deliberately closed. ' +
        'TypeScript has no package-private, so the boundary Go gets from a ' +
        '`_test` package has to be a rule here.',
      severity: 'error',
      from: { pathNot: '\\.(test|contract|testkit)\\.ts$' },
      to: { path: '\\.(contract|testkit)\\.ts$' },
    },

    {
      name: 'S5-shared-is-domain-free',
      comment:
        'S5: the shared layer knows no domain. A module never imports a bounded ' +
        'context or the composition root.',
      severity: 'error',
      from: { path: '^src/shared/' },
      to: { path: ['^src/contexts/', '^src/(wire|main|config|policy)\\.ts$'] },
    },

    {
      name: 'S6-contexts-are-islands',
      comment:
        'S6: contexts never import each other. No exceptions, no shared "common" ' +
        'context. They communicate through domain events.',
      severity: 'error',
      from: { path: '^src/contexts/([^/]+)/' },
      to: { path: '^src/contexts/([^/]+)/', pathNot: '^src/contexts/$1/' },
    },

    {
      name: 'S7-domain-purity',
      comment:
        'S7: domain/ imports only the errors module. No ports, no I/O, no ' +
        'framework, no clock. Time and ids arrive as arguments.',
      severity: 'error',
      from: { path: '^src/contexts/([^/]+)/domain/', pathNot: '\\.test\\.ts$' },
      to: {
        pathNot: ['^src/contexts/$1/domain/', '^src/shared/errors(/|$)'],
      },
    },

    {
      name: 'S8-app-never-imports-adapters',
      comment:
        'S8: dependencies point inward. app/ declares the ports it needs; the ' +
        'composition root injects the implementations.',
      severity: 'error',
      from: {
        path: '^src/contexts/([^/]+)/app/',
        pathNot: '\\.(test|contract)\\.ts$',
      },
      to: { path: '^src/contexts/$1/(infra|transport)/' },
    },
    {
      name: 'S8-adapters-never-meet',
      comment:
        'S8: driving and driven adapters meet in app/, and only the composition ' +
        'root sees both.',
      severity: 'error',
      from: {
        path: '^src/contexts/([^/]+)/(infra|transport)/',
        pathNot: '\\.(test|contract)\\.ts$',
      },
      to: {
        path: '^src/contexts/$1/(infra|transport)/',
        pathNot: '^src/contexts/$1/$2/',
      },
    },

    {
      name: 'S9-root-is-a-leaf',
      comment:
        'S9: the composition root is the only place that knows concrete types, ' +
        'and nothing imports it. Exempt: the in-process composition smoke test.',
      severity: 'error',
      from: { pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(wire|main|config|policy)\\.ts$' },
    },

    ...s10,

    {
      name: 'no-circular',
      comment:
        'A cycle is a layering violation that has not been named yet. Not an ' +
        'S rule; it is the check that keeps the others honest.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ]),

  options: {
    // Type-only imports count. Importing a context purely for its types is
    // still a context import, and erasing at runtime does not make it legal.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },

    doNotFollow: { path: 'node_modules' },
    exclude: {
      // The fixture trees violate these rules on purpose. They are cruised by
      // tests/rules/arch.test.ts, never by `make arch`.
      path: '^tests/rules/fixtures/',
    },

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'node', 'default', 'types'],
      extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
