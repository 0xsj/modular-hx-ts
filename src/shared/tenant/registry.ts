/**
 * The registry, and resolution. **L3 capability.**
 *
 * **Resolution happens before authentication.** From an `x-tenant-id` header or
 * a host subdomain, checked against the registry: unknown is **404**, suspended
 * is **403**. Conformance case 22.
 *
 * The ordering is the point. Resolving *after* auth means a credential issued
 * by tenant A is evaluated in tenant B's context before anyone notices — the
 * session lookup, the role expansion and the audit row all happen against the
 * wrong tenant, and every one of them succeeds.
 *
 * See `notes/patterns/tenant.md`.
 */

import {
  forbidden,
  internal,
  notFound,
  type AppError,
} from '../errors/index.js';
import { err, ok, type Result } from '../result/index.js';
import { DEFAULT_TENANT, Status, Tenancy, type Tenant } from './tenant.js';

export interface Registry {
  byId(id: string): Promise<Tenant | undefined>;
  bySlug(slug: string): Promise<Tenant | undefined>;
  /** For `doctor` and for the seed check. */
  all(): Promise<readonly Tenant[]>;
}

export interface Inbound {
  /** The resolution input, never a value — `PROVENANCE.md` §5. */
  readonly header?: string;
  /** The full `Host`, from which a subdomain may be taken. */
  readonly host?: string;
}

export interface ResolverOptions {
  readonly mode: Tenancy;
  readonly registry: Registry;
  /**
   * The apex the subdomain is taken from — `example.com`, so
   * `acme.example.com` resolves `acme`.
   *
   * Without it, host resolution is off. Guessing which label is the tenant is
   * how a deploy behind a different domain silently resolves the wrong one.
   */
  readonly baseDomain?: string;
}

export interface Resolver {
  resolve(inbound: Inbound): Promise<Result<Tenant>>;
}

/** The subdomain of `host`, if it sits under `baseDomain`. */
export function subdomainOf(
  host: string,
  baseDomain: string,
): string | undefined {
  const bare = host.split(':')[0]?.toLowerCase() ?? '';
  const apex = baseDomain.toLowerCase();
  if (!bare.endsWith(`.${apex}`)) return undefined;

  const label = bare.slice(0, -(apex.length + 1));
  // Only a single label. `a.b.example.com` is not tenant `a.b`, and treating it
  // as one would make an attacker-chosen host resolve somewhere.
  return label === '' || label.includes('.') ? undefined : label;
}

export function makeResolver(options: ResolverOptions): Resolver {
  const { mode, registry } = options;

  return {
    async resolve(inbound) {
      // **Single mode does no lookup at all.** Not a registry hit that happens
      // to return one row — no call. That is what makes it byte-identical to a
      // build with no tenancy, and it is why the header is ignored rather than
      // validated: there is nothing for it to select.
      if (mode === Tenancy.Single) return ok(DEFAULT_TENANT);

      const found = await lookup(inbound);
      if (found === undefined) {
        // **404, not 403.** An unknown tenant must not be distinguishable from
        // one that exists and refused — see the cross-tenant rule.
        return err(notFound('no such tenant'));
      }

      if (found.status === Status.Suspended) {
        // 403 here is correct: the caller reached a tenant it may legitimately
        // know about, and the refusal is about state rather than existence.
        return err(
          forbidden('tenant is suspended', {
            details: { tenant: found.id },
          }),
        );
      }

      return ok(found);
    },
  };

  async function lookup(inbound: Inbound): Promise<Tenant | undefined> {
    // The header wins: it is explicit, and a deploy behind a proxy that
    // rewrites Host would otherwise be unable to address a tenant at all.
    if (inbound.header !== undefined && inbound.header !== '') {
      return (
        (await registry.byId(inbound.header)) ??
        (await registry.bySlug(inbound.header))
      );
    }

    if (inbound.host === undefined || options.baseDomain === undefined) {
      return undefined;
    }

    const slug = subdomainOf(inbound.host, options.baseDomain);
    return slug === undefined ? undefined : registry.bySlug(slug);
  }
}

/**
 * The tenant, or a failure — **never a silent default**.
 *
 * Code that needs a tenant and finds none gets `Internal`. It is a programmer
 * error: a request path that reached here without resolution, or a job that
 * forgot to mint provenance. Returning a default would be the whole module
 * failing open at the one place it must not.
 */
export function requireTenant(tenant: string | undefined): Result<string> {
  if (tenant === undefined || tenant === '') {
    return err(internal('no tenant in scope'));
  }
  return ok(tenant);
}

/** The invisible-not-forbidden refusal. */
export function invisible(what: string): AppError {
  // **404, never 403.** A 403 confirms the resource exists, which turns any id
  // into an oracle for what other tenants hold. Conformance case 23, and the
  // one people get wrong because 403 feels more honest — it is honest to the
  // attacker.
  return notFound(`no such ${what}`);
}
