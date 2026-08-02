import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';

function getSetCookieValues(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatible.getSetCookie === 'function') return compatible.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map(value => value.split(';', 1)[0]).join('; ');
}

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function adminCookies(): Promise<string> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'test-admin@primeprop.invalid',
      password: 'TestAdmin123!',
    }),
  });
  expect(response.status).toBe(200);
  return cookieHeader(getSetCookieValues(response.headers));
}

describe('schema-tolerant administrator user lookup', () => {
  it('returns the stable editor DTO', async () => {
    const response = await workerFetch('/auth/admin-users/2', {
      headers: { Cookie: await adminCookies() },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const body = await response.json() as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(expect.objectContaining({
      id: 2,
      email: 'test-agent@primeprop.invalid',
      name: 'Ada Test Agent',
      role: 'agent',
      phone: '2348012345678',
      avatarUrl: 'https://example.invalid/ada.jpg',
      accountStatus: 'active',
      lastLoginAt: expect.any(String),
      loginCount: expect.any(Number),
      createdAt: expect.any(String),
    }));
    expect(body.data).not.toHaveProperty('password_hash');
    expect(body.data).not.toHaveProperty('security_stamp');
  });

  it('rejects invalid, missing, and unauthenticated lookups', async () => {
    const cookies = await adminCookies();
    const [invalid, missing, unauthenticated] = await Promise.all([
      workerFetch('/auth/admin-users/not-a-number', { headers: { Cookie: cookies } }),
      workerFetch('/auth/admin-users/999999', { headers: { Cookie: cookies } }),
      workerFetch('/auth/admin-users/2'),
    ]);
    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
    expect(unauthenticated.status).toBe(401);
  });
});
