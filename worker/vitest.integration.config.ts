import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/wrangler-integration.test.ts'],
    environment: 'node',
    testTimeout: 45000,
    hookTimeout: 45000,
    sequence: {
      concurrent: false,
    },
  },
});
