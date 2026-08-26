/**
 * The generator. **What it must not do is most of the test.**
 *
 * `MODULES.md`: *generated, committed, diffed.* The first is easy to get right
 * and the third is the one that fails silently — a document whose output
 * depends on the order routes were registered in cannot be diffed, and a drift
 * check over it fires on every unrelated change until somebody deletes it.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type Documented, generate, render } from './index.js';

const Problem = z.object({ type: z.string(), status: z.number() });

const route = (over: Partial<Documented> = {}): Documented => ({
  method: 'GET',
  path: '/v1/things',
  summary: 'List things',
  replies: { 200: z.array(z.object({ id: z.string() })) },
  auth: 'required',
  ...over,
});

const doc = (routes: readonly Documented[]) =>
  generate(routes, { title: 't', version: '1.0.0' });

describe('generating', () => {
  it('templates a router parameter into an OpenAPI one', () => {
    // The registry spells it `:id`; a document spells it `{id}`. Storing both
    // would be two spellings, and the one that drifted would be the published
    // one.
    const built = doc([route({ path: '/v1/things/:id' })]);

    expect(Object.keys(built['paths'] as object)).toEqual(['/v1/things/{id}']);
  });

  it('declares a path parameter as required', () => {
    const built = doc([route({ path: '/v1/things/:id' })]);
    const operation = path(built, '/v1/things/{id}', 'get');

    expect(operation['parameters']).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    ]);
  });

  it('spells an anonymous route as an EMPTY security array', () => {
    // Not an omitted key: omitting means *inherit the document default*, and
    // the two are different documents to a generator downstream.
    const built = doc([route({ auth: 'anonymous' })]);

    expect(path(built, '/v1/things', 'get')['security']).toEqual([]);
  });

  it('requires a bearer on an authenticated one', () => {
    expect(path(doc([route()]), '/v1/things', 'get')['security']).toEqual([
      { bearer: [] },
    ]);
  });

  it('gives a null reply no content rather than a null schema', () => {
    // A 204 has no body. `{ schema: { type: 'null' } }` says it has one that
    // happens to be null, which is a different promise.
    const built = doc([
      route({ method: 'DELETE', replies: { 204: z.null() } }),
    ]);
    const response = responses(built, '/v1/things', 'delete')['204'] as Record<
      string,
      unknown
    >;

    expect(response['content']).toBeUndefined();
  });

  it('renders a 4xx as problem+json and a 2xx as json', () => {
    const built = doc([
      route({ replies: { 200: z.object({}), 404: Problem } }),
    ]);
    const all = responses(built, '/v1/things', 'get');

    expect(
      Object.keys(
        (all['200'] as Record<string, Record<string, unknown>>)['content'] ??
          {},
      ),
    ).toEqual(['application/json']);
    expect(
      Object.keys(
        (all['404'] as Record<string, Record<string, unknown>>)['content'] ??
          {},
      ),
    ).toEqual(['application/problem+json']);
  });

  it('adds the two global statuses S11 exempts from the declaration', () => {
    // The exemption is about where the truth is *written* — repeating them on
    // every route makes the declaration unreadable. A client that has not been
    // told about 500 treats one as a protocol error, so the document says so.
    const all = responses(doc([route()]), '/v1/things', 'get');

    expect(Object.keys(all).sort()).toEqual(['200', '500', '503']);
  });

  it('merges two methods on one path', () => {
    const built = doc([
      route({ method: 'GET' }),
      route({ method: 'POST', body: z.object({ name: z.string() }) }),
    ]);

    expect(Object.keys(built['paths'] as Record<string, object>)).toEqual([
      '/v1/things',
    ]);
    expect(
      Object.keys(
        (built['paths'] as Record<string, object>)['/v1/things'] ?? {},
      ).sort(),
    ).toEqual(['get', 'post']);
  });

  it('describes a request body from the route`s own schema', () => {
    const built = doc([
      route({ method: 'POST', body: z.object({ name: z.string() }) }),
    ]);
    const body = path(built, '/v1/things', 'post')['requestBody'] as Record<
      string,
      Record<string, Record<string, Record<string, Record<string, unknown>>>>
    >;

    expect(
      Object.keys(
        body['content']?.['application/json']?.['schema']?.['properties'] ?? {},
      ),
    ).toEqual(['name']);
  });
});

describe('being diffable — the part that fails silently', () => {
  it('produces identical bytes whatever order the routes arrive in', () => {
    // **The property the drift check is built on.** A generator whose output
    // depends on registration order fires on every unrelated change until
    // somebody deletes the check, which is how `openapi` becomes decoration.
    const a = route({ path: '/v1/a' });
    const b = route({ path: '/v1/b' });
    const c = route({
      path: '/v1/c',
      method: 'POST',
      replies: { 201: z.object({}) },
    });

    expect(render(doc([a, b, c]))).toBe(render(doc([c, a, b])));
  });

  it('produces identical bytes on two runs of the same input', () => {
    expect(render(doc([route()]))).toBe(render(doc([route()])));
  });

  it('CHANGES when a schema changes, which is the point', () => {
    const before = render(doc([route({ replies: { 200: z.object({}) } })]));
    const after = render(
      doc([route({ replies: { 200: z.object({ added: z.string() }) } })]),
    );

    expect(after).not.toBe(before);
  });

  it('ends with a newline, so the file is a well-formed text file', () => {
    expect(render(doc([route()]))).toMatch(/\n$/);
  });
});

describe('operation ids', () => {
  it('is derived from the route rather than maintained beside it', () => {
    // A hand-written `operationId` is a second name for a route, and the second
    // name is the one that goes stale.
    const built = doc([
      route({ method: 'DELETE', path: '/v1/orgs/:id/members/:userId' }),
    ]);

    expect(
      path(built, '/v1/orgs/{id}/members/{userId}', 'delete')['operationId'],
    ).toBe('delete-orgs-by-id-members-by-userId');
  });

  it('is stable across runs', () => {
    const once = path(doc([route()]), '/v1/things', 'get')['operationId'];
    const twice = path(doc([route()]), '/v1/things', 'get')['operationId'];

    expect(once).toBe(twice);
  });
});

function path(
  document: Record<string, unknown>,
  at: string,
  method: string,
): Record<string, unknown> {
  const paths = document['paths'] as Record<string, Record<string, unknown>>;
  const found = paths[at]?.[method];
  if (found === undefined) throw new Error(`no ${method} ${at}`);
  return found as Record<string, unknown>;
}

function responses(
  document: Record<string, unknown>,
  at: string,
  method: string,
): Record<string, unknown> {
  return path(document, at, method)['responses'] as Record<string, unknown>;
}
