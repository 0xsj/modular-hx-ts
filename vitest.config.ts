import { defineConfig } from 'vitest/config';

// The verification ladder, as three projects. `make test` runs `unit` and needs
// nothing; `make test-integration` and `make e2e` need the compose stack.
// See ../INFRASTRUCTURE.md §1.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          // Unit tests sit beside the code they test. The rule tests — the
          // M, N, D and R suites — are unit tests too: they parse files and
          // touch no infrastructure.
          include: [
            'src/**/*.test.ts',
            'tests/rules/**/*.test.ts',
            'tests/smoke/**/*.test.ts',
          ],
          restoreMocks: true,
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          // Probes the database once, in the main process, and hands the answer
          // to every worker. Without it the gate probes per worker and reports
          // the same absence several times over.
          globalSetup: ['tests/testx/global-setup.ts'],
          restoreMocks: true,
          // A real Postgres is slower than a map, and a suite that times out
          // fails for the wrong reason.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          restoreMocks: true,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          // One real binary, one port. Files run in sequence.
          fileParallelism: false,
        },
      },
    ],
  },
});
