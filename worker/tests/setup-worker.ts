import bcrypt from 'bcryptjs';
import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';

const testEnv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
};

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

// Test-only identities. They exist only inside isolated Miniflare D1 and are
// never part of production migrations or public API documentation.
const [adminPasswordHash, agentPasswordHash] = await Promise.all([
  bcrypt.hash('TestAdmin123!', 12),
  bcrypt.hash('TestAgent123!', 12),
]);

await testEnv.DB.batch([
  testEnv.DB.prepare(
    `INSERT OR REPLACE INTO users
     (id, email, password_hash, name, role, account_status, security_stamp, phone, avatar_url, agent_title)
     VALUES (1, ?, ?, ?, 'admin', 'active', ?, ?, ?, ?)`
  ).bind(
    'test-admin@primeprop.invalid',
    adminPasswordHash,
    'PrimeProp Test Admin',
    crypto.randomUUID(),
    '2348099999999',
    'https://example.invalid/admin.jpg',
    'Administrator',
  ),
  testEnv.DB.prepare(
    `INSERT OR REPLACE INTO users
     (id, email, password_hash, name, role, account_status, security_stamp, phone, avatar_url, agent_title)
     VALUES (2, ?, ?, ?, 'agent', 'active', ?, ?, ?, ?)`
  ).bind(
    'test-agent@primeprop.invalid',
    agentPasswordHash,
    'Ada Test Agent',
    crypto.randomUUID(),
    '2348012345678',
    'https://example.invalid/ada.jpg',
    'Service Apartment Specialist',
  ),
]);
