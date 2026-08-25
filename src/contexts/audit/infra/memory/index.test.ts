import { describe } from 'vitest';
import { auditLogContract } from '../../app/ports.contract.js';
import { memoryAuditLog, memoryStore } from './index.js';

describe('memory adapter', () => {
  auditLogContract(() => {
    // A fresh store per case: the dedupe cases would otherwise depend on which
    // order the suite ran in.
    const store = memoryStore();
    return { name: 'memory', log: () => memoryAuditLog(store) };
  });
});
