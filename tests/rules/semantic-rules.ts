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
export const SEMANTIC_RULES = [
  'M2',
  'I5',
  'M13',
  'M6',
  'M9',
  'M4',
  'M3',
] as const;

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

/**
 * M13 — a duration is measured on the monotonic reading.
 *
 * `../MODULES.md` names the modules this binds: `breaker`, `ratelimit`,
 * `retry`, `deadline` and `timers` must never compute an interval from
 * `now()`. Wall time moves backwards under NTP and DST, so a cooldown computed
 * from it can hold a circuit open for an hour after a one-second correction,
 * and close one early after a jump forward.
 *
 * Detects arithmetic on `now()` — subtraction, or a comparison against a stored
 * reading — inside those modules. Stamping a row with `now()` stays legal;
 * only *intervals* are forbidden.
 */
export function m13DurationsAreMonotonic(root: string): Violation[] {
  const BOUND = ['breaker', 'ratelimit', 'retry', 'deadline', 'timers'];

  const inBoundModule = (path: string): boolean =>
    BOUND.some((module) => path.includes(`/src/shared/${module}/`));

  const violations: Violation[] = [];

  for (const file of sourceFiles(root)) {
    const path = file.getFilePath().split(sep).join('/');
    if (!inBoundModule(path) || path.endsWith('.test.ts')) continue;

    const rel = relative(root, file.getFilePath()).split(sep).join('/');

    for (const binary of file.getDescendantsOfKind(
      SyntaxKind.BinaryExpression,
    )) {
      const operator = binary.getOperatorToken().getText();
      if (!['-', '<', '>', '<=', '>='].includes(operator)) continue;

      const text = `${binary.getLeft().getText()} ${binary.getRight().getText()}`;
      if (text.includes('now()')) {
        violations.push({
          rule: 'M13',
          message: `${rel}:${String(binary.getStartLineNumber())} computes an interval from now() — durations use the monotonic reading (M13)`,
        });
      }
    }
  }

  return violations;
}

/**
 * M6 — an event constant in `<ctx>/domain/` is prefixed `<ctx>.`.
 *
 * `../ENFORCEMENT.md`: *an event constant in `<ctx>/domain/` is prefixed
 * `<ctx>.`* An event named for the wrong context routes to the wrong
 * subscribers and lands in the wrong half of the audit graph, and both failures
 * look like nothing at all until somebody goes looking for an event that was
 * published under a name they never search.
 *
 * **This rule lands against nothing.** There are no contexts yet, so today it
 * checks an empty set — which is the phase-0 principle exactly: the rule
 * arrives before the code it governs, so it never needs an allowlist for
 * something that already exists.
 *
 * Detects any string literal in `src/contexts/<ctx>/domain/` that has the shape
 * of an event name, and requires its first segment to be `<ctx>`.
 */
export function m6EventNamesMatchTheirContext(root: string): Violation[] {
  const violations: Violation[] = [];
  const shaped = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

  for (const file of sourceFiles(root)) {
    const rel = relative(root, file.getFilePath()).split(sep).join('/');
    const inDomain = /^src\/contexts\/([^/]+)\/domain\//.exec(rel);
    if (inDomain === null) continue;

    const context = inDomain[1] ?? '';
    for (const literal of file.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
      const value = literal.getLiteralValue();
      if (!shaped.test(value)) continue;
      if (value.startsWith(`${context}.`)) continue;

      violations.push({
        rule: 'M6',
        message: `${rel}:${String(literal.getStartLineNumber())} names the event "${value}" in context ${context} — an event constant is prefixed with its own context (M6)`,
      });
    }
  }

  return violations;
}

/**
 * M9 — every classified field carries a tag.
 *
 * `../ENFORCEMENT.md`: *a field carrying personal or secret data has a
 * `classification` tag.* **Exempt until `classification` ships. Then no
 * exemptions.** It has shipped, so this is live.
 *
 * **Most of M9 is enforced by the type system rather than here.**
 * `classify<T>` takes a `Record<keyof T, Level>`, so adding a field to a type
 * and forgetting to classify it does not compile. Decorators would have been
 * the other idiomatic option and `erasableSyntaxOnly` forbids them, which
 * turned out to be the better constraint.
 *
 * What a type cannot catch is somebody **defeating** the exhaustive record —
 * `as`, `as unknown as`, `Partial<...>`, or a spread that fills the gap with a
 * default. Each one silently reintroduces the unlabelled field, and each one
 * looks deliberate in a diff. That is what this rule detects.
 *
 * It lands with **no contexts in the repository**, so it checks an empty set
 * today. That is the phase-0 principle, and the last moment it is free.
 */
export function m9ClassifiedFieldsAreTagged(root: string): Violation[] {
  const violations: Violation[] = [];

  for (const file of sourceFiles(root)) {
    const rel = relative(root, file.getFilePath()).split(sep).join('/');
    // The module that defines the mechanism is not subject to it.
    if (rel.startsWith('src/shared/classification/')) continue;

    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (call.getExpression().getText() !== 'classify') continue;

      const argument = call.getArguments()[1];
      if (argument === undefined) continue;

      const text = argument.getText();
      const defeats =
        argument.getKind() === SyntaxKind.AsExpression ||
        argument.getKind() === SyntaxKind.TypeAssertionExpression ||
        /\bas\s+(unknown|never|any|Partial|Record)\b/.test(text) ||
        text.includes('...');

      if (defeats) {
        violations.push({
          rule: 'M9',
          message: `${rel}:${String(call.getStartLineNumber())} defeats the exhaustive classification record — every field carries a tag, and an assertion or a spread is how one stops (M9)`,
        });
      }
    }
  }

  return violations;
}

/**
 * M4 — authorization is explicit.
 *
 * `../ENFORCEMENT.md`: *every mutating use case takes a `Subject` parameter.
 * Detect — exported functions in `app/command/` accept a subject type.*
 *
 * **This is the rule the whole module exists to make enforceable.** A `Subject`
 * is a decision input, and an ambient one makes the forgotten check
 * indistinguishable from the passed one — same signature, same call site, no
 * diff. Requiring it in the signature is what turns "somebody remembered" into
 * something a machine can check.
 *
 * Commands only. A query that forgets its subject leaks; a command that forgets
 * it *acts*, and `../ARCHITECTURE.md` Part II §3 rule 6 scopes the requirement
 * to the mutating side. Queries are covered by `tenant`'s fence when it lands.
 *
 * Lands with **no use cases in the repository**, so it asserts nothing today
 * and needs no allowlist. That window closes when `identity` arrives, which is
 * two phases away.
 */
export function m4AuthorizationIsExplicit(root: string): Violation[] {
  const violations: Violation[] = [];

  for (const file of sourceFiles(root)) {
    const rel = relative(root, file.getFilePath()).split(sep).join('/');
    if (!/^src\/contexts\/[^/]+\/app\/command\//.test(rel)) continue;
    if (/\.(test|contract|testkit)\.ts$/.test(rel)) continue;

    for (const fn of file.getFunctions()) {
      if (!fn.isExported()) continue;

      const takesSubject = fn
        .getParameters()
        .some((parameter) => /\bSubject\b/.test(parameter.getType().getText()));

      if (!takesSubject) {
        violations.push({
          rule: 'M4',
          message: `${rel}:${String(fn.getStartLineNumber())} exports ${fn.getName() ?? 'a command'} without a Subject parameter — authorization is explicit, never ambient (M4)`,
        });
      }
    }
  }

  return violations;
}

/**
 * M3 — every query is tenant-scoped.
 *
 * `../ENFORCEMENT.md`: *a repository query filters by the request's tenant.
 * Detect — every SQL statement in a context adapter references the tenant
 * column, **or** the file carries a justified `nolint:tenant` marker naming
 * why.* And the reason it is a rule rather than a convention: **the violation
 * does not error, it returns other people's data.**
 *
 * Scoped to `src/contexts/<ctx>/infra/postgres/`. Shared adapters are not
 * context repositories — `tenant`'s own registry is the obvious case, and it
 * is *about* tenants rather than scoped by one.
 *
 * Statements that cannot be tenant-scoped are real: a `create table`, a
 * `select 1` health probe. They carry the marker with a reason, which is a
 * reviewable line in a diff rather than a silent omission.
 *
 * Lands with **no repositories in the repository**, so it asserts nothing today
 * and needs no allowlist. It stops asserting nothing when `identity` arrives.
 */
export function m3QueriesAreTenantScoped(root: string): Violation[] {
  const violations: Violation[] = [];
  const READS = /\b(select|update|delete)\b/i;

  for (const file of sourceFiles(root)) {
    const rel = relative(root, file.getFilePath()).split(sep).join('/');
    if (!/^src\/contexts\/[^/]+\/infra\/postgres\//.test(rel)) continue;
    if (/\.(test|contract|testkit)\.ts$/.test(rel)) continue;

    const source = file.getFullText();
    // One justified marker exempts the file, and names why in the same line.
    if (/nolint:tenant\s+\S/.test(source)) continue;

    for (const literal of [
      ...file.getDescendantsOfKind(SyntaxKind.StringLiteral),
      ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
      ...file.getDescendantsOfKind(SyntaxKind.TemplateExpression),
    ]) {
      const sql = literal.getText();
      if (!READS.test(sql)) continue;
      if (/\btenant\b/i.test(sql)) continue;

      violations.push({
        rule: 'M3',
        message: `${rel}:${String(literal.getStartLineNumber())} has a statement that does not filter by tenant — the violation returns other people's data rather than an error (M3)`,
      });
    }
  }

  return violations;
}

export function allSemanticRules(root: string): Violation[] {
  return [
    ...m2TimeIsInjected(root),
    ...i5RandomnessIsInjected(root),
    ...m13DurationsAreMonotonic(root),
    ...m6EventNamesMatchTheirContext(root),
    ...m9ClassifiedFieldsAreTagged(root),
    ...m4AuthorizationIsExplicit(root),
    ...m3QueriesAreTenantScoped(root),
  ];
}
