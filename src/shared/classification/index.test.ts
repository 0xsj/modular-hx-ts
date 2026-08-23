import { describe, expect, it } from 'vitest';
import { redactKeys, REDACTED } from '../redact/index.js';
import { unwrap } from '../result/index.js';
import { digest } from '../digest/index.js';
import {
  atLeast,
  classify,
  isLevel,
  Level,
  LEVELS,
  moreSensitive,
  rank,
  redactClassified,
  registry,
  sensitiveKeys,
  UNCLASSIFIED,
} from './index.js';

interface User {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  cardNumber: string;
}

const USER = classify<User>('identity.User', {
  id: Level.Internal,
  email: Level.Pii,
  displayName: Level.Pii,
  passwordHash: Level.Secret,
  cardNumber: Level.Regulated,
});

const ARTICLE = classify<{ slug: string; title: string }>('cms.Article', {
  slug: Level.Public,
  title: Level.Public,
});

describe('the vocabulary is closed and ordered', () => {
  it('has exactly five levels, least to most sensitive', () => {
    // Closed like `errors.Kind`, and for the same reason: a level ends up in
    // canonical bytes and in generated catalogs, so growing it is a
    // canonical-form change. Adding one needs an ADR.
    expect(LEVELS).toEqual([
      'public',
      'internal',
      'pii',
      'secret',
      'regulated',
    ]);
  });

  it('orders regulated above secret above pii above internal above public', () => {
    // The order is the useful part: a consumer asks *at or above pii* rather
    // than enumerating, so adding a level later does not silently narrow every
    // existing check.
    expect(rank(Level.Regulated)).toBeGreaterThan(rank(Level.Secret));
    expect(rank(Level.Secret)).toBeGreaterThan(rank(Level.Pii));
    expect(rank(Level.Pii)).toBeGreaterThan(rank(Level.Internal));
    expect(rank(Level.Internal)).toBeGreaterThan(rank(Level.Public));
  });

  it('answers "at or above" rather than making callers enumerate', () => {
    expect(atLeast(Level.Regulated, Level.Pii)).toBe(true);
    expect(atLeast(Level.Secret, Level.Pii)).toBe(true);
    expect(atLeast(Level.Pii, Level.Pii)).toBe(true);
    expect(atLeast(Level.Internal, Level.Pii)).toBe(false);
    expect(atLeast(Level.Public, Level.Pii)).toBe(false);
  });

  it('takes the more sensitive of two', () => {
    // For a field that inherits from its container.
    expect(moreSensitive(Level.Public, Level.Secret)).toBe(Level.Secret);
    expect(moreSensitive(Level.Regulated, Level.Pii)).toBe(Level.Regulated);
  });

  it('recognises its own values and nothing else', () => {
    for (const level of LEVELS) expect(isLevel(level)).toBe(true);
    expect(isLevel('confidential')).toBe(false);
    expect(isLevel('PII')).toBe(false);
    expect(isLevel(3)).toBe(false);
  });
});

describe('the vocabulary round-trips', () => {
  it('survives JSON, because it is the wire form already', () => {
    const back: unknown = JSON.parse(JSON.stringify({ level: Level.Pii }));
    expect((back as { level: string }).level).toBe('pii');
    expect(isLevel((back as { level: string }).level)).toBe(true);
  });

  it('canonicalises, because it will end up in hashed catalogs', () => {
    // A level is part of the bytes a generated catalog is identified by, which
    // is the other half of why the set is closed.
    expect(unwrap(digest({ level: Level.Regulated }))).toBe(
      unwrap(digest({ level: 'regulated' })),
    );
  });
});

describe('a field gets a level by declaration', () => {
  it('reads back what was declared', () => {
    const r = registry(USER, ARTICLE);

    expect(r.levelOf('identity.User', 'email')).toBe(Level.Pii);
    expect(r.levelOf('identity.User', 'passwordHash')).toBe(Level.Secret);
    expect(r.levelOf('cms.Article', 'slug')).toBe(Level.Public);
  });

  it('never infers from a field name', () => {
    // A guesser that sees `email` and infers PII will also see
    // `email_template_id` and get it wrong in the direction that leaks. This
    // registry declares `slug` public and would declare a field called `email`
    // public too, if that is what the author meant.
    const decoy = classify<{ email_template_id: string }>('cms.Mail', {
      email_template_id: Level.Public,
    });

    expect(registry(decoy).levelOf('cms.Mail', 'email_template_id')).toBe(
      Level.Public,
    );
  });

  it('refuses to classify a type twice', () => {
    // Two opinions about one type is the failure the module exists to prevent.
    expect(() => registry(USER, USER)).toThrow();
  });

  it('lists fields at or above a threshold', () => {
    const r = registry(USER, ARTICLE);

    expect(r.at(Level.Secret)).toEqual([
      'identity.User.cardNumber',
      'identity.User.passwordHash',
    ]);
    expect(r.fieldNamesAt(Level.Pii)).toEqual([
      'cardNumber',
      'displayName',
      'email',
      'passwordHash',
    ]);
  });
});

describe('an unclassified field fails closed', () => {
  it('is the MOST sensitive level, not the least', () => {
    // An unlabelled field is not public. Guessing low means data leaves the
    // building looking compliant; guessing high means somebody adds a label.
    // Only one of those is recoverable after the fact.
    expect(UNCLASSIFIED).toBe(Level.Regulated);
    expect(rank(UNCLASSIFIED)).toBe(LEVELS.length - 1);
  });

  it('applies to an unknown field on a known type', () => {
    // The case that matters: somebody adds a column and not a label.
    expect(registry(USER).levelOf('identity.User', 'ssn')).toBe(
      Level.Regulated,
    );
  });

  it('applies to an entirely unknown type', () => {
    expect(registry(USER).levelOf('billing.Invoice', 'total')).toBe(
      Level.Regulated,
    );
  });

  it('means an unclassified field is at or above every threshold', () => {
    const level = registry(USER).levelOf('identity.User', 'unknown');

    for (const threshold of LEVELS) {
      expect(atLeast(level, threshold)).toBe(true);
    }
  });
});

describe('the redact retrofit', () => {
  it('adds classified field names to redact’s own list', () => {
    // Union, not replacement: the built-in fragments are a backstop for values
    // that never went near a classified type — a raw header map, a third-party
    // payload — and replacing them would quietly un-protect everything nobody
    // has classified yet.
    const keys = sensitiveKeys(registry(USER), Level.Pii);

    expect(keys).toContain('email'); // from the registry
    // **Normalised**, because `redact` normalises the key and matches the
    // fragment as given — so a camelCase fragment matches nothing. Asserting
    // the declared spelling here is what caught that: `displayName` was in the
    // list and being printed in full.
    expect(keys).toContain('displayname');
    expect(keys).toContain('password'); // redact's own
    expect(keys).toContain('authorization'); // redact's own
  });

  it('redacts a classified field that redact alone would have printed', () => {
    // `displayName` matches none of redact's fragments. Before the retrofit it
    // printed; the registry is what changes that.
    const payload = { displayName: 'Ada Lovelace', slug: 'hello' };

    expect(redactKeys(payload)).toEqual(payload);
    expect(redactClassified(payload, registry(USER))).toEqual({
      displayName: REDACTED,
      slug: 'hello',
    });
  });

  it('leaves fields below the threshold alone', () => {
    const payload = { id: 'u1', slug: 'hello' };

    expect(redactClassified(payload, registry(USER, ARTICLE))).toEqual(payload);
  });

  it('takes the threshold as a parameter, because consumers differ', () => {
    // `exports` refuses at or above secret; `readaudit` records at or above
    // pii. One vocabulary, different thresholds — which is the whole point of
    // the levels being ordered.
    const payload = { email: 'ada@example.com', passwordHash: 'x' };

    expect(redactClassified(payload, registry(USER), Level.Secret)).toEqual({
      email: 'ada@example.com',
      passwordHash: REDACTED,
    });
  });
});
