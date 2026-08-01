import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const ADMIN_EMAIL = 'test-admin@primeprop.invalid';
const ADMIN_PASSWORD = 'TestAdmin123!';
const AGENT_EMAIL = 'test-agent@primeprop.invalid';
const AGENT_PASSWORD = 'TestAgent123!';

const testEnv = env as unknown as { DB: D1Database };

type LoginResult = {
  response: Response;
  body: {
    success: boolean;
    data: { csrf: string; user: { id: number; role: string } };
  };
  setCookies: string[];
  cookies: string;
  refreshToken: string;
};

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

async function login(email: string, password: string): Promise<LoginResult> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.clone().json() as LoginResult['body'];
  const setCookies = getSetCookieValues(response.headers);
  return {
    response,
    body,
    setCookies,
    cookies: cookieHeader(setCookies),
    refreshToken: cookieValue(setCookies, 'pp_refresh'),
  };
}

function authenticatedHeaders(session: LoginResult, contentType = false): HeadersInit {
  return {
    Cookie: session.cookies,
    Origin: BASE,
    'X-CSRF-Token': session.body.data.csrf,
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
  };
}

describe.sequential('seeded dashboard data contracts', () => {
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

  it('returns one uncached admin inventory matching the live statistics', async () => {
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(admin.response.status).toBe(200);

    const [inventoryResponse, statsResponse] = await Promise.all([
      workerFetch('/auth/admin-listings?page=1&limit=100', {
        headers: { Cookie: admin.cookies },
      }),
      workerFetch('/api/stats'),
    ]);

    expect(inventoryResponse.status).toBe(200);
    expect(inventoryResponse.headers.get('cache-control')).toContain('no-store');
    const inventory = await inventoryResponse.json() as {
      success: boolean;
      count: number;
      data: Array<Record<string, unknown>>;
    };
    const stats = await statsResponse.json() as { data: { total: number } };

    expect(inventory.success).toBe(true);
    expect(inventory.count).toBe(stats.data.total);
    expect(inventory.data).toHaveLength(stats.data.total);
    expect(inventory.data[0]).toHaveProperty('createdBy');
  });

  it('returns the authenticated admin user collection', async () => {
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await workerFetch('/auth/users', {
      headers: { Cookie: admin.cookies },
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
      expect.objectContaining({
        email: AGENT_EMAIL,
        role: 'agent',
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

    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await workerFetch('/auth/my-listings', {
      headers: { Cookie: admin.cookies },
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

describe.sequential('agent profile and listing permission contracts', () => {
  let agent: LoginResult;
  let listingId = 0;

  it('returns saved listing identity defaults from the agent account', async () => {
    agent = await login(AGENT_EMAIL, AGENT_PASSWORD);
    expect(agent.response.status).toBe(200);
    expect(agent.body.data.user.role).toBe('agent');

    const response = await workerFetch('/auth/profile-settings', {
      headers: { Cookie: agent.cookies },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const body = await response.json() as {
      success: boolean;
      data: Record<string, unknown>;
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual(expect.objectContaining({
      name: 'Ada Test Agent',
      phone: '2348012345678',
      agent_title: 'Service Apartment Specialist',
      avatar_url: 'https://example.invalid/ada.jpg',
    }));
  });

  it('creates a service apartment from profile identity and strips admin-only fields', async () => {
    const response = await workerFetch('/auth/listing-records', {
      method: 'POST',
      headers: authenticatedHeaders(agent, true),
      body: JSON.stringify({
        title: 'Managed Service Apartment',
        type: 'rent',
        property_type: 'service-apartment',
        price: 2400000,
        price_unit: '/ year',
        location: 'Victoria Island, Lagos',
        city: 'Lagos',
        featured: true,
        verified: true,
        badge: 'Featured',
        agent_name: 'Impersonated Agent',
        agent_role: 'Administrator',
        agent_phone: '2348000000000',
        agent_avatar: 'https://evil.invalid/avatar.jpg',
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json() as {
      success: boolean;
      data: { id: number; propertyType: string; featured: boolean; verified: boolean; badge: string; agent: { name: string; role: string; avatar: string } };
    };
    expect(body.success).toBe(true);
    listingId = body.data.id;
    expect(body.data).toEqual(expect.objectContaining({
      propertyType: 'service-apartment',
      featured: false,
      verified: false,
      badge: '',
    }));
    expect(body.data.agent).toEqual(expect.objectContaining({
      name: 'Ada Test Agent',
      role: 'Service Apartment Specialist',
      avatar: 'https://example.invalid/ada.jpg',
    }));

    const stored = await testEnv.DB.prepare(
      `SELECT property_type, featured, verified, badge, agent_name, agent_role, agent_phone, agent_avatar
       FROM listings WHERE id = ?`
    ).bind(listingId).first<any>();
    expect(stored).toEqual(expect.objectContaining({
      property_type: 'service-apartment',
      featured: 0,
      verified: 0,
      badge: '',
      agent_name: 'Ada Test Agent',
      agent_role: 'Service Apartment Specialist',
      agent_phone: '2348012345678',
      agent_avatar: 'https://example.invalid/ada.jpg',
    }));
  });

  it('ignores agent attempts to change moderation or identity fields on update', async () => {
    const response = await workerFetch(`/auth/listing-records/${listingId}`, {
      method: 'PUT',
      headers: authenticatedHeaders(agent, true),
      body: JSON.stringify({
        title: 'Updated Managed Service Apartment',
        featured: true,
        verified: true,
        badge: 'Hot Deal',
        agent_name: 'Different Agent',
        agent_role: 'Admin',
        agent_phone: '111',
        agent_avatar: 'https://evil.invalid/changed.jpg',
      }),
    });
    expect(response.status).toBe(200);

    const stored = await testEnv.DB.prepare(
      `SELECT title, featured, verified, badge, agent_name, agent_role, agent_phone, agent_avatar
       FROM listings WHERE id = ?`
    ).bind(listingId).first<any>();
    expect(stored).toEqual(expect.objectContaining({
      title: 'Updated Managed Service Apartment',
      featured: 0,
      verified: 0,
      badge: '',
      agent_name: 'Ada Test Agent',
      agent_role: 'Service Apartment Specialist',
      agent_phone: '2348012345678',
      agent_avatar: 'https://example.invalid/ada.jpg',
    }));
  });

  it('propagates one profile edit to all existing listings', async () => {
    const response = await workerFetch('/auth/profile-settings', {
      method: 'PUT',
      headers: authenticatedHeaders(agent, true),
      body: JSON.stringify({
        name: 'Ada Updated Agent',
        phone: '2348087654321',
        agent_title: 'Service Apartment Consultant',
        avatar_url: 'https://example.invalid/ada-updated.jpg',
      }),
    });
    expect(response.status).toBe(200);

    const stored = await testEnv.DB.prepare(
      `SELECT agent_name, agent_role, agent_phone, agent_avatar
       FROM listings WHERE id = ?`
    ).bind(listingId).first<any>();
    expect(stored).toEqual({
      agent_name: 'Ada Updated Agent',
      agent_role: 'Service Apartment Consultant',
      agent_phone: '2348087654321',
      agent_avatar: 'https://example.invalid/ada-updated.jpg',
    });
  });

  it('enforces the same trust boundary for direct database writes', async () => {
    await expect(
      testEnv.DB.prepare('UPDATE listings SET featured = 1 WHERE id = ?').bind(listingId).run(),
    ).rejects.toThrow(/centrally managed/i);
  });

  it('denies agent access to administrator inventory and user management', async () => {
    const [inventory, users] = await Promise.all([
      workerFetch('/auth/admin-listings', { headers: { Cookie: agent.cookies } }),
      workerFetch('/auth/users', { headers: { Cookie: agent.cookies } }),
    ]);
    expect(inventory.status).toBe(403);
    expect(users.status).toBe(403);
  });
});

describe.sequential('logout session lifecycle', () => {
  it('rejects cookie logout without the matching CSRF header', async () => {
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    const response = await workerFetch('/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: admin.cookies,
        Origin: BASE,
      },
    });

    expect(response.status).toBe(403);
  });

  it('revokes the refresh family and clears every browser auth cookie', async () => {
    const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    expect(admin.body.data.user.role).toBe('admin');
    expect(admin.refreshToken).toBeTruthy();

    const response = await workerFetch('/auth/logout', {
      method: 'POST',
      headers: authenticatedHeaders(admin),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean };
    expect(body.success).toBe(true);

    const cleared = getSetCookieValues(response.headers).join('\n');
    for (const name of ['pp_session', 'pp_refresh', 'pp_csrf']) {
      expect(cleared).toContain(`${name}=`);
    }
    expect(cleared.match(/Max-Age=0/g)?.length).toBeGreaterThanOrEqual(3);

    const refreshHash = await hashToken(admin.refreshToken);
    const session = await testEnv.DB.prepare(
      'SELECT revoked FROM sessions WHERE token_hash = ?'
    ).bind(refreshHash).first<{ revoked: number }>();
    expect(session?.revoked).toBe(1);

    const noCookieSession = await workerFetch('/auth/session');
    expect(noCookieSession.status).toBe(401);
  });
});
