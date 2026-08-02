import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(currentDirectory, 'migrations'));

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
    include: [
      'tests/runtime-security.test.ts',
      'tests/dashboard-runtime.test.ts',
      'tests/admin-inventory-runtime.test.ts',
      'tests/admin-user-lookup-runtime.test.ts',
      'tests/listing-contact-profile-runtime.test.ts',
    ],
    setupFiles: ['./tests/setup-worker.ts'],
    testTimeout: 30000,
    sequence: {
      concurrent: false,
    },
  },
});
