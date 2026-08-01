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
    ],
    testTimeout: 30000,
  },
});
