/**
 * Blob keys. **The validation is the module.** L2 substrate.
 *
 * A key derived from user input is a path traversal waiting for somebody to
 * concatenate it, and every object store in the world takes a string. So a key
 * is a **value object**: it is constructed or it throws, and nothing else in
 * this module accepts a bare string.
 *
 * **Tenant-scoped means the key encodes the tenant**, not that a filter applies
 * one. `MODULES.md` is explicit and the distinction is the whole security
 * property: a filter is a `where` clause somebody forgets, and the forgetting
 * has no symptom until a customer reads another customer\'s export. A key that
 * *begins* with the tenant cannot address another tenant\'s object however the
 * rest of it is built, because the prefix is not the caller\'s to choose.
 *
 * See `notes/patterns/blob.md`.
 */

import { invalid } from '../errors/index.js';

declare const Brand: unique symbol;

/** A validated key. The only thing the store accepts. */
export type BlobKey = string & { readonly [Brand]: 'BlobKey' };

/**
 * One path segment. **Allow-list, never a deny-list.**
 *
 * Lowercase letters, digits, hyphen, underscore and dot — and a deny-list of
 * `..` would be the version that is wrong: `%2e%2e`, `..%2f`, a UTF-8 overlong
 * encoding and a backslash are all traversal on some store, and each is a
 * separate thing to remember. An allow-list has nothing to remember.
 *
 * **The leading `[a-z0-9]` is what refuses `.` and `..`**, and it is the whole
 * of that rule: a relative segment starts with a dot, and a dot *inside* one —
 * `report.csv` — is untouched. Stated here because an explicit second check
 * lived below for a while and was dead.
 */
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Total length, so a key cannot become a denial of service by itself. */
const MAX_LENGTH = 512;

function segment(value: string, what: string): string {
  if (!SEGMENT.test(value)) {
    throw invalid(`not a usable ${what}: ${value}`, [
      {
        field: what,
        message:
          'is lowercase letters, digits, dot, hyphen and underscore, and starts with a letter or digit',
      },
    ]);
  }
  // **There used to be an explicit `.` / `..` check here, and it was dead.**
  // Deleting it changed nothing, which a breakage pass found and no amount of
  // reading would have: the pattern's leading `[a-z0-9]` already refuses both,
  // because a relative segment starts with a dot. The comment beside it claimed
  // the pattern could not express the rule without forbidding every filename
  // with an extension — the *leading* character is what carries it, and a dot
  // inside a segment is untouched.
  //
  // A redundant guard is not free: it is a second place the rule appears to
  // live, and the day somebody relaxes the first character they will read this
  // and believe they are still covered.
  return value;
}

/**
 * Build a key. **The tenant is the first segment and the caller does not pick
 * it.**
 *
 * The signature is what enforces it: there is no way to construct a `BlobKey`
 * that does not begin with a tenant, because this is the only constructor and
 * it takes one.
 */
export function blobKey(tenant: string, ...parts: readonly string[]): BlobKey {
  if (parts.length === 0) {
    throw invalid('a blob key has at least one segment after the tenant', [
      { field: 'key', message: 'is empty' },
    ]);
  }

  const segments = [
    segment(tenant, 'tenant'),
    ...parts.map((part) => segment(part, 'segment')),
  ];
  const key = segments.join('/');

  if (key.length > MAX_LENGTH) {
    throw invalid('this blob key is too long', [
      {
        field: 'key',
        message: `is longer than ${String(MAX_LENGTH)} characters`,
      },
    ]);
  }

  return key as BlobKey;
}

/**
 * Is this key inside this tenant?
 *
 * The store calls it on every read as a second line — the constructor already
 * makes a cross-tenant key unbuildable, and this catches a key that arrived as
 * a string from somewhere the type system could not follow, such as a database
 * row or a request.
 */
export function within(key: BlobKey, tenant: string): boolean {
  return key.startsWith(`${tenant}/`);
}

/** Re-validate a string that has been round-tripped through a store. */
export function parseKey(raw: string): BlobKey {
  const parts = raw.split('/');
  const [tenant, ...rest] = parts;
  if (tenant === undefined) {
    throw invalid('not a blob key', [{ field: 'key', message: 'is empty' }]);
  }
  return blobKey(tenant, ...rest);
}
