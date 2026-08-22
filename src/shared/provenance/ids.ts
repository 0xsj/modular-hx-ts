/**
 * The id shapes provenance accepts. **L1 runtime, internal to the module.**
 *
 * `../../../PROVENANCE.md` §5 fixes these, and they are normative: the same
 * charset in every language, or a value one implementation accepts is dropped
 * by another and a trace link breaks across a boundary.
 *
 * Not re-exported from `index.ts` — rule `S2` makes that the module boundary,
 * which is how this stays internal without TypeScript having package-private.
 */

/**
 * **1–128 characters, `[A-Za-z0-9._:/-]`.**
 *
 * Narrower than printable ASCII on purpose, and it costs nothing. It accepts
 * every real format — UUID, W3C traceparent, AWS X-Ray, hierarchical ids like
 * `svc/req/3` — and rejects quotes, backslashes, angle brackets and whitespace,
 * which is the log-injection and header-echo surface.
 *
 * Strictness is cheap here because an invalid value is dropped and a fresh one
 * minted, never a request failure: provenance grants nothing.
 */
const PROVENANCE_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

export function isProvenanceId(value: string): boolean {
  return PROVENANCE_ID.test(value);
}

/**
 * W3C `traceparent`: `00-<32 hex>-<16 hex>-<2 hex>`.
 *
 * Validated against its own shape rather than the charset above — a charset
 * test would happily accept `00-zz-…`. An all-zero trace or parent id is
 * invalid per the specification and means "no trace", so it is dropped.
 */
const TRACEPARENT = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export function isTraceparent(value: string): boolean {
  if (!TRACEPARENT.test(value)) return false;

  const [, traceId = '', parentId = ''] = value.split('-');
  return !/^0+$/.test(traceId) && !/^0+$/.test(parentId);
}
