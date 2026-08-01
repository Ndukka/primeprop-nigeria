import { defineConfig } from 'vitest/config';

/**
 * Node-based source tests.
 *
 * Worker-runtime tests use vitest.worker.config.ts. Live wrangler smoke tests
 * use vitest.integration.config.ts. Keeping the environments separate avoids
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
