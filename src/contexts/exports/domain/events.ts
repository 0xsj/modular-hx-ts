/**
 * What `exports` publishes. `<context>.<aggregate>.<past-tense-verb>` — §2.5.
 */

export const ExportEvent = {
  Requested: 'exports.export.requested',
  Completed: 'exports.export.completed',
  Failed: 'exports.export.failed',
  Cancelled: 'exports.export.cancelled',
  Expired: 'exports.export.expired',
  Downloaded: 'exports.export.downloaded',
} as const;

export type ExportEvent = (typeof ExportEvent)[keyof typeof ExportEvent];
