import { Project, SyntaxKind } from 'ts-morph';
import { relative, sep } from 'node:path';

/**
 * The M rules of ../ENFORCEMENT.md — properties of the code beyond its imports.
 *
 * Import boundaries are an edge in a graph, so dependency-cruiser expresses them
 * and `.dependency-cruiser.cjs` holds S1-S10. These are claims about what the
 * code *does*, which needs the syntax tree, so they live here on ts-morph. Each
 * class of rule sits in the tool that can actually express it.
 *
 * M2 today, plus `I5`. The rest land with the modules that define them: M3 needs
 * a repository, M4 a use case, M5 an event envelope — a rule written before the
 * thing it governs would have nothing to parse and no fixture worth writing.
 *
 * **On the name `I5`.** ../ENFORCEMENT.md has no rule for the randomness half of
 * invariant I5; it has M2 for the clock and nothing for the other two legs. The
 * invariant itself is normative and unoverridable, so what is missing is the
 * detection, not the rule — and ENFORCEMENT.md is explicit that a rule with no
 * detection method is only a guideline.
 *
 * So this cites the invariant rather than minting an `M` number locally. Rule
 * ids collide across siblings exactly the way ADR numbers do (rule D7), and
 * this repository's thesis is that the language is the only variable — a rule
 * set that differs from `modular-hx-go` undercuts it. Invariant ids are Part I:
 * identical in every blueprint and never renumbered. When ENFORCEMENT.md gains
 * a proper id for this, the rule renames and nothing else changes.
 */

export interface Violation {
  readonly rule: string;
  readonly message: string;
}

/** The M rules this file enforces. One half of D5's loop. */
export const SEMANTIC_RULES = ['M2', 'I5'] as const;

function sourceFiles(root: string) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: false },
  });
  project.addSourceFilesAtPaths(`${root}/src/**/*.ts`);
  return project.getSourceFiles();
}

/**
 * M2 — time is injected.
 *
 * No module reads the wall clock directly. `clock` is the port, `systemClock`
 * is the one implementation permitted to call the platform, and everything else
 * takes a `Clock`.
 *
 * Detects `Date.now()`, `performance.now()`, and zero-argument `new Date()`.
 * `new Date('2026-01-01')` is deliberately allowed: it names an instant rather
 * than reading one, so it is deterministic and fine in seed data and fixtures.
 *
 * Exempt, per ../ENFORCEMENT.md M2: the `clock` module, and test files. The
 * exemption list is meant to stay short — when a row-writing adapter needs to
 * stamp a timestamp, it is added here by name, not by pattern.
 */
export function m2TimeIsInjected(root: string): Violation[] {
  const exempt = (path: string): boolean =>
    path.includes('/src/shared/clock/') || path.endsWith('.test.ts');

  const violations: Violation[] = [];

  for (const file of sourceFiles(root)) {
    const path = file.getFilePath().split(sep).join('/');
    if (exempt(path)) continue;

    const rel = relative(root, file.getFilePath()).split(sep).join('/');
    const where = (node: { getStartLineNumber: () => number }): string =>
      `${rel}:${String(node.getStartLineNumber())}`;

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      if (callee === 'Date.now' || callee === 'performance.now') {
        violations.push({
          rule: 'M2',
          message: `${where(call)} calls ${callee}() — time is injected; take a Clock (M2)`,
        });
      }
    }

    for (const created of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      if (
        created.getExpression().getText() === 'Date' &&
        created.getArguments().length === 0
      ) {
        violations.push({
          rule: 'M2',
          message: `${where(created)} calls new Date() — time is injected; take a Clock (M2)`,
        });
      }
    }
  }

  return violations;
}

/**
 * I5 — randomness is injected.
 *
 * Only `random` touches a source of entropy. Everything else takes a `Random`,
 * which is what makes a token assertable in a test and what stops
 * `Math.random()` from ever minting a password-reset token.
 *
 * Detects `Math.random()`, `crypto.getRandomValues()`, `crypto.randomUUID()`,
 * and importing an entropy function out of `node:crypto`. `timingSafeEqual` is
 * deliberately not on that list: it is a comparison, not a source.
 *
 * Exempt: the `random` module, and test files.
 */
export function i5RandomnessIsInjected(root: string): Violation[] {
  const CALLS = new Set([
    'Math.random',
    'crypto.getRandomValues',
    'crypto.randomUUID',
  ]);
  const ENTROPY_IMPORTS = new Set([
    'randomBytes',
    'randomFillSync',
    'randomInt',
    'randomUUID',
    'getRandomValues',
  ]);

  const exempt = (path: string): boolean =>
    path.includes('/src/shared/random/') || path.endsWith('.test.ts');

  const violations: Violation[] = [];

  for (const file of sourceFiles(root)) {
    const path = file.getFilePath().split(sep).join('/');
    if (exempt(path)) continue;

    const rel = relative(root, file.getFilePath()).split(sep).join('/');
    const where = (node: { getStartLineNumber: () => number }): string =>
      `${rel}:${String(node.getStartLineNumber())}`;

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      if (CALLS.has(callee)) {
        violations.push({
          rule: 'I5',
          message: `${where(call)} calls ${callee}() — randomness is injected; take a Random (I5)`,
        });
      }
    }

    for (const declaration of file.getImportDeclarations()) {
      const from = declaration.getModuleSpecifierValue();
      if (from !== 'node:crypto' && from !== 'crypto') continue;

      for (const named of declaration.getNamedImports()) {
        const name = named.getName();
        if (ENTROPY_IMPORTS.has(name)) {
          violations.push({
            rule: 'I5',
            message: `${where(named)} imports ${name} from ${from} — randomness is injected; take a Random (I5)`,
          });
        }
      }
    }
  }

  return violations;
}

export function allSemanticRules(root: string): Violation[] {
  return [...m2TimeIsInjected(root), ...i5RandomnessIsInjected(root)];
}
