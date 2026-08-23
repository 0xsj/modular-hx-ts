import { describe, expect, it } from 'vitest';
import { fakeClock } from '../clock/index.js';
import { fakeIds } from '../id/index.js';
import { unwrap, isErr } from '../result/index.js';
import { mailerContract, draft, ada } from './mailertest.js';
import { memoryMailer, noopMailer } from './memory.js';
import { compileTemplates } from './templates.js';

const TEMPLATES = {
  'welcome.subject': 'Welcome, {{ name }}',
  'welcome.txt': 'Hello {{ name }}. Visit {{ link }}.',
  'welcome.html': '<p>Hello {{ name }}. <a href="{{ link }}">Visit</a>.</p>',
  'welcome.de.subject': 'Willkommen, {{ name }}',
  'welcome.de.txt': 'Hallo {{ name }}. Besuche {{ link }}.',
  // Deliberately no `welcome.de.html` — the per-part fallback case.
};

describe('templates', () => {
  it('compile at boot, so a broken one fails startup', () => {
    // Rather than the first password reset at 3am.
    const broken = compileTemplates({
      'x.subject': 'Hi {{ name }',
      'x.txt': 'ok',
      'x.html': '<p>ok</p>',
    });

    expect(isErr(broken)).toBe(true);
  });

  it('refuse a template missing a default part', () => {
    // A locale falling back to nothing is worse than a startup failure.
    const partial = compileTemplates({
      'x.subject': 'Hi',
      'x.txt': 'ok',
    });

    expect(isErr(partial)).toBe(true);
    expect(String(isErr(partial) ? partial.error : '')).toContain('.html');
  });

  it('refuse a key that is not <name>[.<lang>].<part>', () => {
    expect(isErr(compileTemplates({ 'welcome.body': 'x' }))).toBe(true);
  });

  it('interpolate, and auto-escape only the HTML part', () => {
    // A user-supplied display name in a welcome email is the obvious injection.
    const templates = unwrap(compileTemplates(TEMPLATES));

    const out = unwrap(
      templates.render('welcome', undefined, {
        name: '<script>alert(1)</script>',
        link: 'https://example.com/v?t=1',
      }),
    );

    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<script>');
    // Not escaped in the plain-text part, where entities would be noise.
    expect(out.text).toContain('<script>alert(1)</script>');
    expect(out.subject).toContain('<script>');
  });

  it('fall back PER PART, not per template', () => {
    // The case that matters: a missing `de.html` falls back to the default
    // html while a present `de.subject` is still used. Falling back whole
    // would mean one untranslated part silently discards every translated one.
    const templates = unwrap(compileTemplates(TEMPLATES));

    const out = unwrap(
      templates.render('welcome', 'de', {
        name: 'Ada',
        link: 'https://x.test',
      }),
    );

    expect(out.subject).toBe('Willkommen, Ada'); // localised
    expect(out.text).toContain('Hallo Ada'); // localised
    expect(out.html).toContain('Hello Ada'); // fell back, alone
  });

  it('fall back entirely for a language with no parts at all', () => {
    const templates = unwrap(compileTemplates(TEMPLATES));

    const out = unwrap(
      templates.render('welcome', 'fr', {
        name: 'Ada',
        link: 'https://x.test',
      }),
    );

    expect(out.subject).toBe('Welcome, Ada');
  });

  it('refuse a template that does not exist', () => {
    const templates = unwrap(compileTemplates(TEMPLATES));

    expect(isErr(templates.render('nope', undefined, {}))).toBe(true);
  });

  it('list what can be rendered', () => {
    expect(unwrap(compileTemplates(TEMPLATES)).names()).toEqual(['welcome']);
  });
});

describe('the memory adapter', () => {
  mailerContract(() => {
    const clock = fakeClock();
    const mailer = memoryMailer({ clock, ids: fakeIds(clock) });
    return {
      name: 'memory',
      mailer: () => mailer,
      readBack: (to) => {
        const last = mailer.lastTo(to);
        return Promise.resolve(
          last === undefined
            ? undefined
            : {
                subject: last.message.subject,
                text: last.message.text,
                html: last.message.html,
              },
        );
      },
    };
  });

  it('logs the link at debug, so a dev flow is completable with no Docker', async () => {
    // Not a test double: this is what lets STORAGE=memory run identity's
    // verification flow. If the link were not retrievable, the flow would be
    // unfinishable on a fresh clone.
    const clock = fakeClock();
    const lines: { message: string; fields?: Record<string, unknown> }[] = [];
    const mailer = memoryMailer({
      clock,
      ids: fakeIds(clock),
      reporter: {
        debug: (message, fields) => {
          lines.push({ message, ...(fields === undefined ? {} : { fields }) });
        },
      },
    });

    await mailer.send(draft());

    expect(lines[0]?.fields?.['link']).toBe(
      'https://example.com/verify?token=abc',
    );
  });

  it('keeps a mailbox a test can read back', async () => {
    const clock = fakeClock();
    const mailer = memoryMailer({ clock, ids: fakeIds(clock) });

    await mailer.send(draft({ subject: 'first' }));
    await mailer.send(draft({ subject: 'second' }));

    expect(mailer.outbox()).toHaveLength(2);
    expect(mailer.lastTo(ada.email)?.message.subject).toBe('second');
    mailer.clear();
    expect(mailer.outbox()).toEqual([]);
  });
});

describe('the none adapter', () => {
  mailerContract(() => {
    const clock = fakeClock();
    return {
      name: 'none',
      mailer: () => noopMailer(clock, fakeIds(clock)),
      // Nothing to read back, and saying so beats a stub that pretends.
    };
  });
});
