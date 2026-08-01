import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));

      return {
        wrangler: {
          configPath: './wrangler.toml',
        },
        miniflare: {
          bindings: {
            ENVIRONMENT: 'test',
            JWT_SECRET: 'primeprop-test-only-secret-not-for-production-2026',
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    include: ['tests/runtime-security.test.ts'],
    setupFiles: ['./tests/setup-worker.ts'],
    testTimeout: 30000,
  },
});
