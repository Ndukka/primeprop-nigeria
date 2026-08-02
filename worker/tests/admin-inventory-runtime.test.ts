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

describe.sequential('stable administrator inventories', () => {
  it('returns uncached districts with the exact dashboard DTO', async () => {
    const cookies = await adminCookies();
    const response = await workerFetch('/auth/admin-districts', {
      headers: { Cookie: cookies },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json() as {
      success: boolean;
      count: number;
      data: Array<Record<string, unknown>>;
    };

    expect(body.success).toBe(true);
    expect(body.count).toBeGreaterThan(0);
    expect(body.data).toHaveLength(body.count);
    expect(body.data[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      name: expect.any(String),
      city: expect.any(String),
      checks: expect.any(Array),
      linkType: expect.any(String),
    }));
    expect(body.data[0]).not.toHaveProperty('link_type');
  });

  it('returns uncached users with stable optional activity fields', async () => {
    const cookies = await adminCookies();
    const response = await workerFetch('/auth/admin-users', {
      headers: { Cookie: cookies },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json() as {
      success: boolean;
      count: number;
      data: Array<Record<string, unknown>>;
    };

    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(body.count);
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: 'test-admin@primeprop.invalid',
        role: 'admin',
        accountStatus: 'active',
        lastLoginAt: expect.any(String),
        loginCount: expect.any(Number),
        createdAt: expect.any(String),
      }),
      expect.objectContaining({
        email: 'test-agent@primeprop.invalid',
        role: 'agent',
        accountStatus: 'active',
      }),
    ]));
  });

  it('denies both inventories to an unauthenticated request', async () => {
    const [districts, users] = await Promise.all([
      workerFetch('/auth/admin-districts'),
      workerFetch('/auth/admin-users'),
    ]);

    expect(districts.status).toBe(401);
    expect(users.status).toBe(401);
  });
});
