/**
 * The layer assignment of every shared module, and the vendor SDK table.
 *
 * One source of truth, read by two independent enforcers:
 *   - `.dependency-cruiser.cjs` turns it into the S1 and S10 import rules
 *   - the docs test checks every module note names the same layer (N7)
 *   - the arch test checks this map is **total** — every module under
 *     `src/shared/` has a row. This header used to claim the docs test did
 *     that; it did not, and a module missing from here is not un-ordered but
 *     *unchecked*: it appears in no S1 rule and passes in silence.
 *
 * Build order is layer order, and a module imports only from strictly lower
 * layers. Same-layer imports are allowed and flagged in review, never by a test.
 *
 * When a module does not obviously belong to a layer, it is usually two modules.
 */

const LAYERS = [
  {
    id: 'L0',
    name: 'kernel',
    intent: 'Pure. Runs with no fixtures, no fakes, no infrastructure.',
    modules: [
      'errors',
      'result',
      'brand',
      'assert',
      'clock',
      'id',
      'random',
      'retry',
      'breaker',
      'digest',
      'pagination',
      'buildinfo',
      'redact',
      // Promoted out of `identity/app/` when `orgs` needed the identical
      // mechanics for an invitation: `S6` makes a context's code unreachable
      // from the next one, so the choice was a second copy or a shared module.
      'token',
    ],
  },
  {
    id: 'L1',
    name: 'runtime',
    intent: 'Describes this process, not the domain.',
    modules: [
      'provenance',
      'logger',
      'env',
      'secrets',
      'lifecycle',
      'health',
      'telemetry',
    ],
  },
  {
    id: 'L2',
    name: 'substrate',
    intent:
      'I/O. Every module here has a port, a memory adapter, a real adapter, ' +
      "and one contract suite both pass. That is the layer's definition.",
    modules: [
      'postgres',
      'events',
      'jobs',
      'lock',
      'mailer',
      'httpclient',
      // Object storage. A port, a memory twin, a filesystem adapter and one
      // contract suite both pass — which is this layer's whole definition.
      'blob',
      // A durable queue. Enqueued inside the caller's transaction, which is why
      // it is here rather than beside `jobs`: it needs `postgres`'s handle.
      'work',
    ],
  },
  {
    id: 'L3',
    name: 'capability',
    intent: 'Makes a real decision, knows no domain.',
    modules: [
      'authz',
      'tenant',
      'crypto',
      'classification',
      'flags',
      // 202 + Location + poll + cancel. L3 because it makes a real decision —
      // a terminal state never moves — and knows no domain: `kind` is the
      // owning context's word and this module never reads it.
      'operations',
      // The out-of-band link around `token`: an id and a MAC tag on the wire.
      // Above L0 because it needs `crypto`; separate from `token` because a
      // session has no MAC and no journey outside the system.
      'secretlink',
    ],
  },
  {
    id: 'L4',
    name: 'edge',
    intent: 'Speaks a wire protocol.',
    // `edge` first, and first on purpose: it is the **floor of L4**
    // (ARCHITECTURE.md §L4, which names it) — the handler and middleware types
    // every other member needs in order to be written at all. It carries the
    // layer's own name because it is the layer's vocabulary, the same
    // relationship `errors` has to L0. Enforced the same way as that one: by
    // ordering and review rather than by the cruiser, because both are
    // same-layer imports.
    modules: [
      'edge',
      'httpx',
      // `httproute` above `edge`: it speaks HTTP, holds no policy, and every
      // context's transport uses it. Shared rather than copied, because `S6`
      // makes a context's registry unreachable from the next one and copying
      // defeats the single registry `openapi` has to walk.
      'httproute',
      'idempotency',
      'ratelimit',
      'conditional',
      'openapi',
    ],
  },
];

/**
 * A vendor SDK is imported only by the module that wraps it — the OpenTelemetry
 * rule, generalized (S10). The table grows when a module takes on a dependency.
 * An SDK absent from it is unconfined, which is right for anything with no
 * wrapper: zod is used at every boundary and belongs to no one module.
 */
const VENDOR_SDKS = [
  {
    owner: 'telemetry',
    packages: ['@opentelemetry/sdk-.*', '@opentelemetry/exporter-.*'],
    comment: 'The OTel API is free; the SDK is not.',
  },
  { owner: 'postgres', packages: ['pg', 'pg-.*'] },
  { owner: 'mailer', packages: ['nodemailer'] },
  { owner: 'httpx', packages: ['fastify', '@fastify/.*'] },
  { owner: 'logger', packages: ['pino', 'pino-.*'] },
];

module.exports = { LAYERS, VENDOR_SDKS };
