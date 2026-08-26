/**
 * The `Organization` aggregate. **`orgs` domain.**
 *
 * Found, rename, archive. Small on purpose: the interesting rules in this
 * context are about the **roster**, not about the organization row, and putting
 * them here would be putting a set invariant on one member of the set.
 *
 * See `notes/domain/orgs.md`.
 */

import { invalid } from '../../../shared/errors/index.js';
import { type OrgId } from './ids.js';

export interface OrgState {
  readonly id: OrgId;
  readonly name: string;
  /** Lowercased, url-safe, unique. What a human types instead of a uuid. */
  readonly slug: string;
  readonly archivedAt?: Date | undefined;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Whether a mutation changed anything, for the idempotent ones (§2.1). */
export interface Changed {
  readonly changed: boolean;
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/;

/**
 * Normalize at construction, never at use (§7.2).
 *
 * Lowercased and trimmed here, so the unique index is a plain one — a
 * functional index on `lower(slug)` would be a *second* normalization, and the
 * two would eventually disagree about some slug neither was written for.
 */
export function slug(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!SLUG.test(value)) {
    throw invalid(`not a usable slug: ${raw}`, [
      {
        field: 'slug',
        message:
          'is lowercase letters, digits and hyphens, 1-62 characters, not starting or ending with a hyphen',
      },
    ]);
  }
  return value;
}

/**
 * Derive a slug from a name. **Not the same function as `slug`.**
 *
 * `slug` *validates* one somebody supplied; this *derives* one nobody did, and
 * the default for `found` is this rather than that. Passing the name straight
 * to the validator was the first version, and it refused every organization
 * whose name had a space in it — which is most of them, and which every unit
 * test missed because they were all called `Acme`.
 *
 * Lossy on purpose: two names can derive the same slug, and the unique index
 * refuses the second. A caller who cares supplies one.
 */
export function slugify(name: string): string {
  const derived = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 62)
    // A trailing hyphen can reappear after the slice.
    .replace(/-+$/g, '');

  if (derived === '') {
    throw invalid(`no slug can be derived from ${name}`, [
      { field: 'name', message: 'has no letters or digits in it' },
    ]);
  }
  return slug(derived);
}

export class Organization {
  #name: string;
  #archivedAt: Date | undefined;
  #version: number;
  #updatedAt: Date;

  readonly id: OrgId;
  readonly slug: string;
  readonly createdAt: Date;
  readonly baseVersion: number;

  private constructor(state: OrgState) {
    this.id = state.id;
    this.slug = state.slug;
    this.createdAt = state.createdAt;
    this.baseVersion = state.version;

    this.#name = state.name;
    this.#archivedAt = state.archivedAt;
    this.#version = state.version;
    this.#updatedAt = state.updatedAt;
  }

  static found(
    id: OrgId,
    name: string,
    at: Date,
    named = slugify(name),
  ): Organization {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw invalid('an organization has a name', [
        { field: 'name', message: 'is required' },
      ]);
    }
    return new Organization({
      id,
      name: trimmed,
      slug: named,
      version: 1,
      createdAt: at,
      updatedAt: at,
    });
  }

  static from(state: OrgState): Organization {
    return new Organization(state);
  }

  get name(): string {
    return this.#name;
  }
  get archivedAt(): Date | undefined {
    return this.#archivedAt;
  }
  get archived(): boolean {
    return this.#archivedAt !== undefined;
  }
  get version(): number {
    return this.#version;
  }
  get updatedAt(): Date {
    return this.#updatedAt;
  }

  rename(name: string, at: Date): Changed {
    const trimmed = name.trim();
    if (trimmed === '') {
      throw invalid('an organization has a name', [
        { field: 'name', message: 'is required' },
      ]);
    }
    if (trimmed === this.#name) return { changed: false };
    this.#name = trimmed;
    this.#touch(at);
    return { changed: true };
  }

  /**
   * Archive it. **Idempotent, and it reports whether it changed anything.**
   *
   * The same shape `User.disable` has, for the same reason: a command can then
   * publish its event exactly once instead of on every repeated call, and a
   * caller retrying is not a caller producing a second event.
   *
   * **Archived is not deleted.** The memberships and the audit trail stay, and
   * so does the slug — releasing it would let somebody else take the name of an
   * organization whose records still exist.
   */
  archive(at: Date): Changed {
    if (this.#archivedAt !== undefined) return { changed: false };
    this.#archivedAt = at;
    this.#touch(at);
    return { changed: true };
  }

  #touch(at: Date): void {
    this.#version += 1;
    this.#updatedAt = at;
  }

  toState(): OrgState {
    return {
      id: this.id,
      name: this.#name,
      slug: this.slug,
      ...(this.#archivedAt === undefined
        ? {}
        : { archivedAt: this.#archivedAt }),
      version: this.#version,
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
    };
  }
}
