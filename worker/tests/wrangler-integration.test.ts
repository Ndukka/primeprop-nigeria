import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const PORT = 8789;
const BASE = `http://127.0.0.1:${PORT}`;
const WORKER_DIR = resolve(__dirname, '..');
const STATE_DIR = resolve(WORKER_DIR, '.wrangler', 'integration-state');
const WRANGLER_CLI = resolve(
  WORKER_DIR,
  'node_modules',
  '@cloudflare',
  'vitest-pool-workers',
  'node_modules',
  'wrangler',
  'bin',
  'wrangler.js',
);
const TEST_JWT_SECRET = 'primeprop-integration-only-secret-not-for-production';

let devProcess: ChildProcess | undefined;

function wranglerArgs(...args: string[]): string[] {
  return [WRANGLER_CLI, ...args];
}

beforeAll(async () => {
  if (!existsSync(WRANGLER_CLI)) {
    throw new Error(`Locked Wrangler CLI was not found at ${WRANGLER_CLI}`);
  }

  rmSync(STATE_DIR, { recursive: true, force: true });

  execFileSync(process.execPath, wranglerArgs(
    'd1', 'migrations', 'apply', 'primeprop-db',
    '--local',
    '--persist-to', STATE_DIR,
  ), {
    cwd: WORKER_DIR,
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
  });

  devProcess = spawn(process.execPath, wranglerArgs(
    'dev',
    '--port', String(PORT),
    '--local',
    '--persist-to', STATE_DIR,
    '--var', `JWT_SECRET:${TEST_JWT_SECRET}`,
  ), {
    cwd: WORKER_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1' },
  });

  await new Promise<void>((resolveReady, rejectReady) => {
    let output = '';
    const timeout = setTimeout(() => {
      rejectReady(new Error(`wrangler dev did not start within 35 seconds. Output:\n${output}`));
    }, 35000);

    const inspect = (chunk: Buffer) => {
      output += chunk.toString();
      if (/Ready on|http:\/\/127\.0\.0\.1|http:\/\/localhost/i.test(output)) {
        clearTimeout(timeout);
        setTimeout(resolveReady, 750);
      }
    };

    devProcess?.stdout?.on('data', inspect);
    devProcess?.stderr?.on('data', inspect);
    devProcess?.once('exit', code => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        rejectReady(new Error(`wrangler dev exited early with code ${code}. Output:\n${output}`));
      }
    });
  });
}, 45000);

afterAll(async () => {
  if (devProcess && !devProcess.killed) {
    devProcess.kill('SIGTERM');
    await new Promise(resolveDone => setTimeout(resolveDone, 500));
  }
  rmSync(STATE_DIR, { recursive: true, force: true });
});

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, options);
}

describe('static asset and CSP delivery', () => {
  it('serves the shared stylesheet', async () => {
    const response = await request('/styles.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/css');
    expect((await response.text()).length).toBeGreaterThan(1000);
  });

  it('serves the shared application script', async () => {
    const response = await request('/js/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/javascript|text\/plain/);
    expect(await response.text()).toContain('loadDistricts');
  });

  it('serves clean and explicit HTML routes with a matching nonce CSP', async () => {
    for (const path of ['/areas', '/areas.html']) {
      const response = await request(path);
      expect(response.status).toBe(200);

      const csp = response.headers.get('content-security-policy') || '';
      const html = await response.text();
      const nonceMatch = csp.match(/script-src 'nonce-([^']+)'/);

      expect(nonceMatch?.[1]).toBeTruthy();
      expect(html).toContain(`nonce="${nonceMatch?.[1]}"`);
      expect(csp).toContain("style-src-attr 'unsafe-inline'");
      expect(csp).toContain('https://cdnjs.cloudflare.com');
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    }
  });
});

describe('API and routing smoke tests', () => {
  it('returns stats from a migrated local D1 database', async () => {
    const response = await request('/api/stats');
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { total: number } };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('total');
  });

  it('returns mandatory pagination', async () => {
    const response = await request('/api/listings?page=1&limit=10');
    expect(response.status).toBe(200);
    const body = await response.json() as { page: number; limit: number; data: unknown[] };
    expect(body.page).toBe(1);
    expect(body.limit).toBe(10);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('returns a generic API 404', async () => {
    const response = await request('/api/nonexistent');
    expect(response.status).toBe(404);
    const body = await response.json() as { message: string };
    expect(body.message).toBe('Not found');
    expect(body.message).not.toContain('/api/nonexistent');
  });

  it('does not reflect an unapproved CORS origin', async () => {
    const response = await request('/api/listings?page=1&limit=5', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(response.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('rejects encoded image path traversal', async () => {
    const response = await request('/api/images/%2e%2e/%2e%2e/worker/wrangler.toml');
    expect(response.status).toBe(404);
  });
});

describe('public authentication behavior', () => {
  it('creates a pending account without exposing duplicate-email state', async () => {
    const email = `integration-${Date.now()}@example.invalid`;
    const body = JSON.stringify({ email, password: 'Integration123!', name: 'Integration User' });

    const first = await request('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const second = await request('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });

  it('rejects malformed JSON and forged bearer tokens', async () => {
    const malformed = await request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{{{broken',
    });
    expect(malformed.status).toBe(400);

    const forged = await request('/auth/session', {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.invalid' },
    });
    expect(forged.status).toBe(401);
  });
});
