import bcrypt from 'bcryptjs';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

// Test-only identity. It is created inside the isolated Miniflare D1 database
// and is never part of production migrations or public API documentation.
const passwordHash = await bcrypt.hash('TestAdmin123!', 12);
await testEnv.DB.prepare(
  `INSERT OR REPLACE INTO users
   (id, email, password_hash, name, role, account_status, security_stamp)
   VALUES (1, ?, ?, ?, 'admin', 'active', ?)`
).bind(
  'test-admin@primeprop.invalid',
  passwordHash,
  'PrimeProp Test Admin',
  crypto.randomUUID(),
).run();
