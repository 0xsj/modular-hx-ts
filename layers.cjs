/**
 * The layer assignment of every shared module, and the vendor SDK table.
 *
 * One source of truth, read by two independent enforcers:
 *   - `.dependency-cruiser.cjs` turns it into the S1 and S10 import rules
 *   - the docs test checks every module note names the same layer (N7), and
 *     that no module on disk is missing from it
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
    modules: ['postgres', 'events', 'jobs', 'lock', 'mailer', 'httpclient'],
  },
  {
    id: 'L3',
    name: 'capability',
    intent: 'Makes a real decision, knows no domain.',
    modules: ['authz', 'tenant', 'crypto', 'classification', 'flags'],
  },
  {
    id: 'L4',
    name: 'edge',
    intent: 'Speaks a wire protocol.',
    modules: ['httpx', 'idempotency', 'ratelimit', 'conditional', 'openapi'],
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
