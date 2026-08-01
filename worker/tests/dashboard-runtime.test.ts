import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const ADMIN_EMAIL = 'test-admin@primeprop.invalid';
const ADMIN_PASSWORD = 'TestAdmin123!';

const testEnv = env as unknown as { DB: D1Database };

function getSetCookieValues(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatible.getSetCookie === 'function') return compatible.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map(value => value.split(';', 1)[0]).join('; ');
}

function cookieValue(setCookies: string[], name: string): string {
  for (const value of setCookies) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));
    if (match) return match[1];
  }
  return '';
}

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loginAsAdmin() {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const body = await response.clone().json() as {
    success: boolean;
    data: { csrf: string; user: { id: number; role: string } };
  };
  const setCookies = getSetCookieValues(response.headers);
  return {
    response,
    body,
    setCookies,
    cookies: cookieHeader(setCookies),
    refreshToken: cookieValue(setCookies, 'pp_refresh'),
  };
}

describe('seeded dashboard data contracts', () => {
  it('returns seeded listings, districts, and matching statistics', async () => {
    const [listingsResponse, districtsResponse, statsResponse] = await Promise.all([
      workerFetch('/api/listings?page=1&limit=100'),
      workerFetch('/api/districts'),
      workerFetch('/api/stats'),
    ]);

    expect(listingsResponse.status).toBe(200);
    expect(districtsResponse.status).toBe(200);
    expect(statsResponse.status).toBe(200);

    const listings = await listingsResponse.json() as {
      success: boolean;
      count: number;
      data: Array<Record<string, unknown>>;
    };
    const districts = await districtsResponse.json() as {
      success: boolean;
      data: Array<{ id: number; link_type: string; checks: string[] }>;
    };
    const stats = await statsResponse.json() as {
      success: boolean;
      data: { total: number; rent: number; sale: number; land: number };
    };

    expect(listings.success).toBe(true);
    expect(listings.count).toBeGreaterThan(0);
    expect(listings.data.length).toBe(listings.count);
    expect(listings.data[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      title: expect.any(String),
      propertyType: expect.any(String),
      priceUnit: expect.any(String),
    }));

    expect(districts.success).toBe(true);
    expect(districts.data.length).toBeGreaterThan(0);
    expect(districts.data[0]).toEqual(expect.objectContaining({
      id: expect.any(Number),
      link_type: expect.any(String),
      checks: expect.any(Array),
    }));

    expect(stats.success).toBe(true);
    expect(stats.data.total).toBe(listings.count);
    expect(stats.data.rent + stats.data.sale + stats.data.land).toBe(stats.data.total);
  });

  it('returns the authenticated admin user collection', async () => {
    const login = await loginAsAdmin();
    expect(login.response.status).toBe(200);

    const response = await workerFetch('/auth/users', {
      headers: { Cookie: login.cookies },
    });
    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: Array<{ email: string; role: string; account_status: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        email: ADMIN_EMAIL,
        role: 'admin',
        account_status: 'active',
      }),
    ]));
  });

  it('returns camelCase listing fields from the authenticated ownership endpoint', async () => {
    await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, price_unit, location, city, created_by)
       VALUES (?, 'rent', 'apartment', 750000, '/ year', 'Runtime Test Estate', 'Lagos', 1)`
    ).bind(`Owned listing ${crypto.randomUUID()}`).run();

    const login = await loginAsAdmin();
    const response = await workerFetch('/auth/my-listings', {
      headers: { Cookie: login.cookies },
    });
    expect(response.status).toBe(200);

    const body = await response.json() as {
      success: boolean;
      data: Array<Record<string, unknown>>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        propertyType: 'apartment',
        priceUnit: '/ year',
      }),
    ]));
  });
});

describe('logout session lifecycle', () => {
  it('rejects cookie logout without the matching CSRF header', async () => {
    const login = await loginAsAdmin();
    const response = await workerFetch('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: login.cookies,
        Origin: BASE,
      },
    });

    expect(response.status).toBe(403);
  });

  it('revokes the refresh family and clears every browser auth cookie', async () => {
    const login = await loginAsAdmin();
    expect(login.body.data.user.role).toBe('admin');
    expect(login.refreshToken).toBeTruthy();

    const response = await workerFetch('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: login.cookies,
        Origin: BASE,
        'X-CSRF-Token': login.body.data.csrf,
      },
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean };
    expect(body.success).toBe(true);

    const cleared = getSetCookieValues(response.headers).join('\n');
    for (const name of ['pp_session', 'pp_refresh', 'pp_csrf']) {
      expect(cleared).toContain(`${name}=`);
    }
    expect(cleared.match(/Max-Age=0/g)?.length).toBeGreaterThanOrEqual(3);

    const refreshHash = await hashToken(login.refreshToken);
    const session = await testEnv.DB.prepare(
      'SELECT revoked FROM sessions WHERE token_hash = ?'
    ).bind(refreshHash).first<{ revoked: number }>();
    expect(session?.revoked).toBe(1);

    const noCookieSession = await workerFetch('/auth/session');
    expect(noCookieSession.status).toBe(401);
  });
});
