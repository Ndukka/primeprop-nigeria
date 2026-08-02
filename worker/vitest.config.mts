import { defineConfig } from 'vitest/config';

/**
 * Node-based source tests.
 *
 * Worker-runtime tests use vitest.worker.config.mts. Live Wrangler smoke tests
 * use vitest.integration.config.mts. Keeping the environments separate avoids
 * running child_process/fs-heavy tests inside workerd.
 */
export default defineConfig({
  test: {
    include: [
      'tests/static-analysis.test.ts',
      'tests/security-headers.test.ts',
      'tests/navigation-regressions.test.ts',
      'tests/dashboard-client-regressions.test.ts',
      'tests/admin-inventory-client-regressions.test.ts',
      'tests/cloudflare-usage-regressions.test.ts',
      'tests/listing-approval-regressions.test.ts',
      'tests/feedback-regressions.test.ts',
      'tests/feedback-ux-csrf-regressions.test.ts',
      'tests/session-refresh-regressions.test.ts',
      'tests/cache-coherency-regressions.test.ts',
    ],
    testTimeout: 30000,
  },
});
