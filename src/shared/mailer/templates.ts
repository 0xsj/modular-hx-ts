/**
 * Templates: `<name>[.<lang>].{subject,txt,html}`. **L2 substrate.**
 *
 * **Compiled at boot, so a broken template fails startup** rather than the
 * first password reset at 3am. That is the whole reason compilation is a
 * separate step from rendering: a missing placeholder or an unclosed tag is a
 * deploy-time failure with a stack trace, not a runtime one discovered by the
 * user who most needed the mail to arrive.
 *
 * **Locale fallback is per part.** A missing `de.html` falls back to the default
 * `html` while a present `de.subject` is still used. Falling back whole-template
 * would mean one untranslated part silently discards every translated one —
 * which is how a German user gets an entirely English email because somebody
 * had not finished the HTML yet.
 *
 * See `notes/patterns/mailer.md`.
 */

import { invalid } from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';

export type Part = 'subject' | 'txt' | 'html';

export const PARTS: readonly Part[] = ['subject', 'txt', 'html'];

/** Values a template may interpolate. Primitives only, like an event payload. */
export type Vars = Readonly<Record<string, string | number | boolean>>;

/**
 * The source set, keyed `<name>[.<lang>].<part>`.
 *
 * Supplied by the composition root — embedded in the binary in a real
 * deployment, and a literal in a test. `mailer` does not read the filesystem:
 * that would make a template a deployment artifact and put an I/O failure in the
 * path of every send.
 */
export type Sources = Readonly<Record<string, string>>;

export interface Rendered {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export interface Templates {
  /** Every template name that has at least a default of each required part. */
  names(): readonly string[];
  render(name: string, lang: string | undefined, vars: Vars): Result<Rendered>;
}

/** `{{ name }}` — one placeholder form, deliberately. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Escape for HTML.
 *
 * Applied to **every** interpolated value in an `.html` part and to none in a
 * `.txt` or `.subject` part. A user-supplied display name in a welcome email is
 * the obvious injection, and the escape happening automatically is what keeps a
 * template author from having to remember.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface Compiled {
  readonly render: (vars: Vars) => string;
  readonly required: readonly string[];
}

/** Split `welcome.de.html` into its name, language and part. */
function parseKey(
  key: string,
): { name: string; lang?: string; part: Part } | undefined {
  const segments = key.split('.');
  const part = segments.pop();
  if (part === undefined || !PARTS.includes(part as Part)) return undefined;
  if (segments.length === 0) return undefined;

  // `welcome.de` -> lang `de`; `welcome` -> no lang. A language tag is two or
  // three letters, optionally region-suffixed, which is what distinguishes it
  // from a template name containing a dot.
  const last = segments[segments.length - 1] ?? '';
  if (segments.length > 1 && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(last)) {
    return {
      name: segments.slice(0, -1).join('.'),
      lang: last,
      part: part as Part,
    };
  }
  return { name: segments.join('.'), part: part as Part };
}

function compile(key: string, source: string): Result<Compiled> {
  const required = new Set<string>();
  for (const match of source.matchAll(PLACEHOLDER)) {
    required.add(match[1] ?? '');
  }

  // An unclosed or malformed placeholder is the failure worth catching at boot:
  // `{{ name }` renders as literal text and nobody notices until a customer
  // forwards the email.
  const stray = /\{\{(?![^}]*\}\})|(?<!\{\{[^{}]*)\}\}/.exec(source);
  if (stray !== null) {
    return err(invalid(`${key}: malformed placeholder near "${stray[0]}"`));
  }

  const isHtml = key.endsWith('.html');

  return ok({
    required: [...required],
    render: (vars) =>
      source.replace(PLACEHOLDER, (_whole, name: string) => {
        const value = vars[name];
        const text = value === undefined ? '' : String(value);
        return isHtml ? escapeHtml(text) : text;
      }),
  });
}

/**
 * Compile every template, or fail with everything that is wrong.
 *
 * Called once, at boot, by the composition root.
 */
export function compileTemplates(sources: Sources): Result<Templates> {
  const compiled = new Map<string, Compiled>();
  const problems: string[] = [];
  const names = new Set<string>();

  for (const [key, source] of Object.entries(sources)) {
    const parsed = parseKey(key);
    if (parsed === undefined) {
      problems.push(`${key}: not <name>[.<lang>].{subject,txt,html}`);
      continue;
    }

    const result = compile(key, source);
    if (!result.ok) {
      problems.push(result.error.message);
      continue;
    }
    compiled.set(key, result.value);
    if (parsed.lang === undefined) names.add(parsed.name);
  }

  // A template missing a default part can never be rendered — better to know at
  // boot than to discover it when a locale falls back to nothing.
  for (const name of names) {
    for (const part of PARTS) {
      if (!compiled.has(`${name}.${part}`)) {
        problems.push(`${name}: has no default .${part}`);
      }
    }
  }

  if (problems.length > 0) {
    return err(
      invalid(
        `${String(problems.length)} template problem(s): ${problems.join('; ')}`,
      ),
    );
  }

  const pick = (name: string, lang: string | undefined, part: Part) =>
    // Per part: the localised one if it exists, the default otherwise.
    (lang === undefined
      ? undefined
      : compiled.get(`${name}.${lang}.${part}`)) ??
    compiled.get(`${name}.${part}`);

  return ok({
    names: () => [...names].sort(),

    render(name, lang, vars) {
      const subject = pick(name, lang, 'subject');
      const text = pick(name, lang, 'txt');
      const html = pick(name, lang, 'html');

      if (subject === undefined || text === undefined || html === undefined) {
        return err(invalid(`no such template: ${name}`));
      }

      return ok({
        subject: subject.render(vars),
        text: text.render(vars),
        html: html.render(vars),
      });
    },
  });
}
