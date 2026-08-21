import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The N, D and R rules of ../ENFORCEMENT.md, as functions over a repository
 * root. Split from the test file so the same checks run against the real repo
 * and against fixture roots built to trip exactly one of them.
 *
 * Not implemented here, each for a stated reason:
 *   N8  needs the INDEX.md generator, which is phase 9
 *   R1  needs README.md completed to the standard sections
 *   R2  needs docs/ARCHITECTURE.md to name every module with its layer
 *   D5  belongs with the last phase-0 box, which wires rules to their ADR
 *   D3, D6, R8  are not mechanically checkable, and ENFORCEMENT.md says so
 */

export interface Violation {
  readonly rule: string;
  readonly message: string;
}

// --- reading the repository ------------------------------------------------

const NOTE_CATEGORIES = ['language', 'patterns', 'domain', 'techniques'];

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function directories(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

interface Note {
  readonly path: string;
  readonly rel: string;
  readonly body: string;
  readonly frontMatter: Readonly<Record<string, string>>;
}

/**
 * A note may carry YAML front matter. Module notes must: it is how N1 pairs a
 * note with the module it documents, and how N7 states the layer.
 *
 *     ---
 *     module: clock
 *     layer: L0
 *     ---
 */
function parseFrontMatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (pair?.[1] !== undefined && pair[2] !== undefined) {
      result[pair[1]] = pair[2].trim();
    }
  }
  return result;
}

export function notes(root: string): Note[] {
  return NOTE_CATEGORIES.flatMap((category) =>
    walk(join(root, 'notes', category))
      .filter((path) => path.endsWith('.md'))
      .map((path) => {
        const body = readFileSync(path, 'utf8');
        return {
          path,
          rel: relative(root, path).split(sep).join('/'),
          body,
          frontMatter: parseFrontMatter(body),
        };
      }),
  );
}

interface Adr {
  readonly rel: string;
  readonly body: string;
  readonly number: string;
}

export function adrs(root: string): Adr[] {
  return walk(join(root, 'docs', 'decisions'))
    .filter((path) => /\/\d{4}-[^/]*\.md$/.test(path.split(sep).join('/')))
    .map((path) => {
      const rel = relative(root, path).split(sep).join('/');
      return {
        rel,
        body: readFileSync(path, 'utf8'),
        number: /(\d{4})-/.exec(rel)?.[1] ?? '',
      };
    });
}

/** The body of one `## Section`, up to the next heading of the same level. */
function section(body: string, heading: string): string {
  const start = body.indexOf(heading);
  if (start === -1) return '';
  const rest = body.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
}

function headings(body: string): string[] {
  return [...body.matchAll(/^#{2,3}\s+(.+?)\s*$/gm)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
}

// --- N · notes -------------------------------------------------------------

/** N1 — every L0-L4 module has a note. */
export function n1ModuleNotes(root: string): Violation[] {
  const documented = new Set(
    notes(root)
      .map((n) => n.frontMatter['module'])
      .filter((m): m is string => m !== undefined),
  );

  return directories(join(root, 'src', 'shared'))
    .filter((module) => !documented.has(module))
    .map((module) => ({
      rule: 'N1',
      message: `src/shared/${module} has no note (N1)`,
    }));
}

/** N2 — every bounded context has a note in notes/domain/. */
export function n2ContextNotes(root: string): Violation[] {
  const documented = new Set(
    notes(root)
      .filter((n) => n.rel.startsWith('notes/domain/'))
      .map((n) => n.frontMatter['context'])
      .filter((c): c is string => c !== undefined),
  );

  return directories(join(root, 'src', 'contexts'))
    .filter((context) => !documented.has(context))
    .map((context) => ({
      rule: 'N2',
      message: `src/contexts/${context} has no note in notes/domain/ (N2)`,
    }));
}

/**
 * N3 — notes carry the standard sections. Example may be omitted where a note
 * is purely conceptual; Used in may never be.
 */
export function n3NoteSections(root: string): Violation[] {
  const required = ['what', 'why', 'gotchas', 'used in', 'related'];

  return notes(root).flatMap((note) => {
    const present = headings(note.body);
    return required
      .filter((section) => !present.includes(section))
      .map((section) => ({
        rule: 'N3',
        message: `${note.rel} has no "## ${section}" section (N3)`,
      }));
  });
}

/** N4 — every wikilink resolves, or is declared a forward link. */
export function n4LinksResolve(root: string): Violation[] {
  const all = notes(root);
  const known = new Set(all.map((n) => n.rel.replace(/^.*\/|\.md$/g, '')));
  const forward = read(join(root, 'notes', 'FORWARD.md')) ?? '';

  return all.flatMap((note) =>
    [...note.body.matchAll(/\[\[([^\]]+)\]\]/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((link) => !known.has(link) && !forward.includes(`[[${link}]]`))
      .map((link) => ({
        rule: 'N4',
        message: `${note.rel} links to [[${link}]], which does not exist and is not in notes/FORWARD.md (N4)`,
      })),
  );
}

/**
 * N5 — every path cited in a note exists.
 *
 * A backticked token counts as a path when it contains a slash and starts at a
 * root this repo has. That deliberately ignores prose like `make ci` and bare
 * identifiers like `pg`, and deliberately includes `../ENFORCEMENT.md`, which
 * is a real file until the collection documents are vendored in.
 */
export function n5CitedPathsExist(root: string): Violation[] {
  const looksLikePath =
    /^(\.\.\/|\.\/)?(src|tests|docs|notes|deploy)\/\S+$|^\.\.\/[A-Z][\w-]*\.md$/;

  return notes(root).flatMap((note) =>
    [...note.body.matchAll(/`([^`\n]+)`/g)]
      .map((m) => (m[1] ?? '').trim())
      .filter((token) => looksLikePath.test(token))
      .filter((token) => !existsSync(join(root, token)))
      .map((token) => ({
        rule: 'N5',
        message: `${note.rel} cites \`${token}\`, which does not exist (N5)`,
      })),
  );
}

/** N6 — every ADR a note references exists and carries a status. */
export function n6CitedAdrsExist(root: string): Violation[] {
  const local = new Map(adrs(root).map((adr) => [adr.number, adr]));

  return notes(root).flatMap((note) =>
    [...note.body.matchAll(/ADR (\d{4})/g)]
      .map((m) => m[1] ?? '')
      .flatMap((number) => {
        const adr = local.get(number);
        if (adr === undefined) {
          return [
            {
              rule: 'N6',
              message: `${note.rel} references ADR ${number}, which does not exist (N6)`,
            },
          ];
        }
        return adr.body.includes('**Status:**')
          ? []
          : [
              {
                rule: 'N6',
                message: `${note.rel} references ADR ${number}, which has no status (N6)`,
              },
            ];
      }),
  );
}

/**
 * N7 — a module note states its layer, making S1 reviewable by a human.
 * It is checked against layers.cjs, so the two statements must agree.
 */
export function n7ModuleNotesNameTheirLayer(
  root: string,
  layerOf: ReadonlyMap<string, string>,
): Violation[] {
  return notes(root)
    .filter((note) => note.frontMatter['module'] !== undefined)
    .flatMap((note) => {
      const module = note.frontMatter['module'] ?? '';
      const stated = note.frontMatter['layer'];
      const actual = layerOf.get(module);

      if (stated === undefined) {
        return [
          { rule: 'N7', message: `${note.rel} does not name its layer (N7)` },
        ];
      }
      if (actual !== undefined && stated !== actual) {
        return [
          {
            rule: 'N7',
            message: `${note.rel} says ${module} is ${stated}; layers.cjs says ${actual} (N7)`,
          },
        ];
      }
      return [];
    });
}

// --- D · decisions ---------------------------------------------------------

/** D1 — required shape: a Status/Date line, then the four sections. */
export function d1AdrShape(root: string): Violation[] {
  const required = [
    'context',
    'decision',
    'alternatives considered',
    'consequences',
  ];

  return adrs(root).flatMap((adr) => {
    const present = headings(adr.body);
    const missing = required
      .filter((section) => !present.includes(section))
      .map((section) => ({
        rule: 'D1',
        message: `${adr.rel} has no "## ${section}" section (D1)`,
      }));

    const stamped = /\*\*Status:\*\*.*·.*\*\*Date:\*\*/.test(adr.body);
    return stamped
      ? missing
      : [
          {
            rule: 'D1',
            message: `${adr.rel} has no "**Status:** … · **Date:** …" line (D1)`,
          },
          ...missing,
        ];
  });
}

/** D2 — status vocabulary, and a superseded ADR names its successor. */
export function d2AdrStatus(root: string): Violation[] {
  const allowed = ['Proposed', 'Accepted', 'Implemented', 'Superseded'];

  return adrs(root).flatMap((adr) => {
    const status = /\*\*Status:\*\*\s*([A-Za-z]+)/.exec(adr.body)?.[1];

    if (status === undefined || !allowed.includes(status)) {
      return [
        {
          rule: 'D2',
          message: `${adr.rel} has status "${status ?? 'none'}"; expected one of ${allowed.join(' | ')} (D2)`,
        },
      ];
    }
    if (status === 'Superseded' && !/ADR \d{4}/.test(adr.body)) {
      return [
        {
          rule: 'D2',
          message: `${adr.rel} is Superseded but names no successor (D2)`,
        },
      ];
    }
    return [];
  });
}

/** D4 — every ADR names how its central claim is verified, or says it is not. */
export function d4AdrVerification(root: string): Violation[] {
  return adrs(root)
    .filter(
      (adr) =>
        !headings(adr.body).includes('verification') &&
        !/not verified/i.test(adr.body),
    )
    .map((adr) => ({
      rule: 'D4',
      message: `${adr.rel} names no verification, and does not say it is unverified (D4)`,
    }));
}

/**
 * The rule ids this file enforces. Paired with the S ids read off
 * `.dependency-cruiser.cjs`, this is one half of D5's loop.
 */
export const DOC_RULES = [
  'N1',
  'N2',
  'N3',
  'N4',
  'N5',
  'N6',
  'N7',
  'D1',
  'D2',
  'D4',
  'D5',
  'D7',
  'R3',
  'R4',
  'R6',
  'R7',
] as const;

/**
 * D5 — every rule cites the ADR that mandates it, and every ADR names the rules
 * that enforce it. Checked in both directions, because half a loop is how a
 * rule ends up with no reason and an ADR ends up with no teeth.
 *
 * The other half — that each rule in `.dependency-cruiser.cjs` cites an ADR
 * that exists — lives in the architecture suite, next to the rules themselves.
 */
export function d5AdrsNameTheirRules(
  root: string,
  enforced: readonly string[],
): Violation[] {
  const all = adrs(root);
  // With no ADRs at all there is no loop to close, and R4 already says so.
  if (all.length === 0) return [];

  const violations: Violation[] = [];
  const claimed = new Set<string>();

  for (const adr of all) {
    if (!adr.body.includes('## Enforced by')) {
      violations.push({
        rule: 'D5',
        message: `${adr.rel} has no "## Enforced by" section (D5)`,
      });
      continue;
    }
    for (const match of section(adr.body, '## Enforced by').matchAll(
      /`([ISMNDR]\d{1,2})`/g,
    )) {
      claimed.add(match[1] ?? '');
    }
  }

  for (const id of [...claimed].sort()) {
    if (!enforced.includes(id)) {
      violations.push({
        rule: 'D5',
        message: `an ADR names ${id} as enforced, but nothing enforces it (D5)`,
      });
    }
  }
  for (const id of enforced) {
    if (!claimed.has(id)) {
      violations.push({
        rule: 'D5',
        message: `${id} is enforced but no ADR mandates it (D5)`,
      });
    }
  }

  return violations;
}

/**
 * D7 — a cross-repo ADR reference names the repo, because numbers collide.
 * A reference resolves if it is this repo's own, or the collection's, or the
 * line names a sibling.
 */
export function d7AdrCrossRepoReferences(root: string): Violation[] {
  const local = new Set(adrs(root).map((adr) => adr.number));
  const collection = new Set(
    walk(join(root, '..', 'decisions'))
      .map((path) => /(\d{4})-/.exec(path)?.[1])
      .filter((n): n is string => n !== undefined),
  );

  return adrs(root).flatMap((adr) =>
    adr.body
      .split(/\r?\n/)
      .flatMap((line) =>
        [...line.matchAll(/ADR (\d{4})/g)].map((m) => ({
          number: m[1] ?? '',
          line,
        })),
      )
      .filter(
        ({ number, line }) =>
          !(number === adr.number) &&
          !local.has(number) &&
          !collection.has(number) &&
          !/modular-[\w-]+/.test(line),
      )
      .map(({ number }) => ({
        rule: 'D7',
        message: `${adr.rel} references ADR ${number} without naming a repo, and no such ADR is local or in the collection (D7)`,
      })),
  );
}

// --- R · repository documents ----------------------------------------------

/**
 * The files R3 tracks: the code and the toolchain. Documents are governed by
 * their own rules (R1, R2, R4, N1), and gitignored files are not part of the
 * blueprint at all.
 */
function trackedSourceFiles(root: string): string[] {
  const ignoredRoots = /^(docs\/|notes\/|README\.md$)/;

  const files = existsSync(join(root, '.git'))
    ? execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard'],
        {
          cwd: root,
          encoding: 'utf8',
        },
      )
        .split('\n')
        .filter(Boolean)
    : walk(root)
        .map((path) => relative(root, path).split(sep).join('/'))
        .filter((path) => !path.startsWith('node_modules/'));

  return files.filter((path) => !ignoredRoots.test(path));
}

/**
 * The files docs/TREE.md claims exist: the first cell of every row in a table
 * headed `| File | Description |`.
 *
 * Scoped to that header on purpose. Prose mentions paths rhetorically — "a
 * minimal `src/` tree" — and other tables in the same section have a first
 * column that is not a file at all. Neither is a claim that something exists.
 */
function describedPaths(tree: string): string[] {
  const lines = tree.split(/\r?\n/);
  const paths: string[] = [];
  let inFileTable = false;

  for (const line of lines) {
    if (/^\|\s*File\s*\|\s*Description\s*\|/.test(line)) {
      inFileTable = true;
      continue;
    }
    if (!line.startsWith('|')) {
      inFileTable = false;
      continue;
    }
    if (!inFileTable || /^\|\s*-+\s*\|/.test(line)) continue;

    const firstCell = /^\|\s*([^|]+?)\s*\|/.exec(line)?.[1] ?? '';
    for (const match of firstCell.matchAll(/`([^`\n]+)`/g)) {
      const token = (match[1] ?? '').trim();
      if (/^[\w./-]+$/.test(token)) paths.push(token);
    }
  }

  return paths;
}

/**
 * R3 — docs/TREE.md matches the filesystem, in both directions.
 *
 * Both directions read the File descriptions tables, and only those. Unticked
 * checkboxes are the build queue: they name files that do not exist yet, so
 * they cannot be existence claims — and they must not count as coverage
 * either, or `src/shared/errors/` in the queue would silently vouch for every
 * file anyone ever puts under it. TREE.md's own rule is that a description is
 * filled in as a file is created; this is that sentence, enforced.
 *
 * A row naming a directory covers everything beneath it, which is how one row
 * stands in for the fixture trees.
 */
export function r3TreeMatchesFilesystem(root: string): Violation[] {
  const tree = read(join(root, 'docs', 'TREE.md'));
  if (tree === undefined) {
    return [{ rule: 'R3', message: 'docs/TREE.md does not exist (R3)' }];
  }

  const described = describedPaths(tree);
  const covers = (file: string): boolean =>
    described.some(
      (token) =>
        token === file || (token.endsWith('/') && file.startsWith(token)),
    );

  const undescribed = trackedSourceFiles(root)
    .filter((file) => !covers(file))
    .map((file) => ({
      rule: 'R3',
      message: `${file} exists but is not described in docs/TREE.md (R3)`,
    }));

  const absent = described
    .filter((token) => !existsSync(join(root, token)))
    .map((token) => ({
      rule: 'R3',
      message: `docs/TREE.md describes ${token}, which does not exist (R3)`,
    }));

  return [...undescribed, ...absent];
}

/** R4 — the architecture ADR exists. */
export function r4ArchitectureAdrExists(root: string): Violation[] {
  return adrs(root).some((adr) => adr.number === '0001')
    ? []
    : [{ rule: 'R4', message: 'docs/decisions/0001-*.md does not exist (R4)' }];
}

/**
 * R6 — every deferred module appears in TREE -> Later with a trigger, and no
 * module is both built and deferred.
 */
export function r6DeferredHaveTriggers(
  root: string,
  builtModules: readonly string[],
): Violation[] {
  // Bounded to its own section: File descriptions follows Later in TREE.md,
  // and reading to end of file turns every described file into a deferral.
  const later = section(read(join(root, 'docs', 'TREE.md')) ?? '', '## Later');
  const built = new Set(builtModules);

  return [...later.matchAll(/^\|\s*`([^`]+)`\s*\|([^|]*)\|/gm)].flatMap(
    (row) => {
      const module = (row[1] ?? '').trim();
      const trigger = (row[2] ?? '').trim();

      if (trigger.length < 10) {
        return [
          {
            rule: 'R6',
            message: `docs/TREE.md defers ${module} with no trigger — a deferral without a trigger is an omission (R6)`,
          },
        ];
      }
      if (built.has(module)) {
        return [
          {
            rule: 'R6',
            message: `docs/TREE.md defers ${module}, but layers.cjs assigns it a layer (R6)`,
          },
        ];
      }
      return [];
    },
  );
}

/** R7 — diagrams are ASCII. A diagram you cannot diff is one nobody updates. */
export function r7DiagramsAreAscii(root: string): Violation[] {
  const binary = /\.(png|jpe?g|gif|svg|pdf|drawio|vsdx|excalidraw)$/i;

  const assets = ['docs', 'notes'].flatMap((dir) =>
    walk(join(root, dir))
      .map((path) => relative(root, path).split(sep).join('/'))
      .filter((path) => binary.test(path)),
  );

  const embeds = ['docs', 'notes'].flatMap((dir) =>
    walk(join(root, dir))
      .filter((path) => path.endsWith('.md'))
      .flatMap((path) => {
        const rel = relative(root, path).split(sep).join('/');
        return [
          ...readFileSync(path, 'utf8').matchAll(/!\[[^\]]*\]\(([^)]+)\)/g),
        ].map((m) => `${rel} embeds ${m[1] ?? ''}`);
      }),
  );

  return [
    ...assets.map((path) => ({
      rule: 'R7',
      message: `${path} is a binary diagram; diagrams are ASCII (R7)`,
    })),
    ...embeds.map((where) => ({
      rule: 'R7',
      message: `${where}; diagrams are ASCII (R7)`,
    })),
  ];
}

// --- everything ------------------------------------------------------------

export function allRules(
  root: string,
  layerOf: ReadonlyMap<string, string>,
  builtModules: readonly string[],
  enforcedRules: readonly string[],
): Violation[] {
  return [
    ...n1ModuleNotes(root),
    ...n2ContextNotes(root),
    ...n3NoteSections(root),
    ...n4LinksResolve(root),
    ...n5CitedPathsExist(root),
    ...n6CitedAdrsExist(root),
    ...n7ModuleNotesNameTheirLayer(root, layerOf),
    ...d1AdrShape(root),
    ...d2AdrStatus(root),
    ...d4AdrVerification(root),
    ...d5AdrsNameTheirRules(root, enforcedRules),
    ...d7AdrCrossRepoReferences(root),
    ...r3TreeMatchesFilesystem(root),
    ...r4ArchitectureAdrExists(root),
    ...r6DeferredHaveTriggers(root, builtModules),
    ...r7DiagramsAreAscii(root),
  ];
}
