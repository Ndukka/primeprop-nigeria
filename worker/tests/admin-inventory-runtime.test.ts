import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const testEnv = env as unknown as { DB: D1Database };

type LoginSession = {
  cookies: string;
  csrf: string;
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

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function loginSession(email: string, password: string): Promise<LoginSession> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  const body = await response.clone().json() as { data: { csrf: string } };
  return {
    cookies: cookieHeader(getSetCookieValues(response.headers)),
    csrf: body.data.csrf,
  };
}

async function adminCookies(): Promise<string> {
  return (await loginSession('test-admin@primeprop.invalid', 'TestAdmin123!')).cookies;
}

function mutationHeaders(session: LoginSession): HeadersInit {
  return {
    Cookie: session.cookies,
    Origin: BASE,
    'X-CSRF-Token': session.csrf,
  };
}

describe.sequential('stable administrator inventories', () => {
  it('returns public district guides with one stable camelCase DTO', async () => {
    const response = await workerFetch('/auth/district-guides');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('public');
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

describe.sequential('public listing contact redirects', () => {
  it('opens WhatsApp and phone actions without exposing the number in listing JSON', async () => {
    const listingResponse = await workerFetch('/api/listings/1');
    const listing = await listingResponse.json() as {
      success: boolean;
      data: { agent: { phone: string } };
    };
    expect(listing.success).toBe(true);
    expect(listing.data.agent.phone).toBe('');

    const [whatsapp, call] = await Promise.all([
      workerFetch('/auth/listing-contact/1/whatsapp'),
      workerFetch('/auth/listing-contact/1/call'),
    ]);

    expect(whatsapp.status).toBe(302);
    expect(whatsapp.headers.get('cache-control')).toContain('no-store');
    expect(whatsapp.headers.get('location')).toMatch(/^https:\/\/wa\.me\/2348000000001\?text=/);
    expect(call.status).toBe(302);
    expect(call.headers.get('location')).toBe('tel:+2348000000001');
  });

  it('does not publish contact routes for an inactive account owner', async () => {
    const inserted = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, agent_phone, created_by)
       VALUES (?, 'rent', 'apartment', 1000000, 'Contact Test', 'Lagos', '2348011111111', 2)`,
    ).bind(`Inactive contact ${crypto.randomUUID()}`).run();
    const listingId = Number(inserted.meta.last_row_id);

    await testEnv.DB.prepare("UPDATE users SET account_status = 'banned' WHERE id = 2").run();
    try {
      const response = await workerFetch(`/auth/listing-contact/${listingId}/whatsapp`);
      expect(response.status).toBe(404);
      const body = await response.json() as { message: string };
      expect(body.message).toMatch(/not available/i);
    } finally {
      await testEnv.DB.batch([
        testEnv.DB.prepare("UPDATE users SET account_status = 'active' WHERE id = 2"),
        testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(listingId),
      ]);
    }
  });

  it('rejects invalid or missing listing contacts', async () => {
    const [invalid, missing] = await Promise.all([
      workerFetch('/auth/listing-contact/not-a-number/whatsapp'),
      workerFetch('/auth/listing-contact/999999/whatsapp'),
    ]);
    expect(invalid.status).toBe(400);
    expect(missing.status).toBe(404);
  });
});

describe.sequential('ownership-aware listing deletion', () => {
  it('lets an agent delete only their own listing', async () => {
    const agent = await loginSession('test-agent@primeprop.invalid', 'TestAgent123!');
    const owned = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by)
       VALUES (?, 'rent', 'apartment', 1000000, 'Delete Test', 'Lagos', 2)`,
    ).bind(`Agent-owned delete ${crypto.randomUUID()}`).run();
    const ownedId = Number(owned.meta.last_row_id);

    const response = await workerFetch(`/auth/listing-records/${ownedId}`, {
      method: 'DELETE',
      headers: mutationHeaders(agent),
    });
    expect(response.status).toBe(200);
    expect(await testEnv.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(ownedId).first()).toBeNull();
  });

  it('rejects deletion of another account’s listing', async () => {
    const agent = await loginSession('test-agent@primeprop.invalid', 'TestAgent123!');
    const other = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by)
       VALUES (?, 'sale', 'duplex', 5000000, 'Protected Delete Test', 'Lagos', 1)`,
    ).bind(`Admin-owned delete ${crypto.randomUUID()}`).run();
    const otherId = Number(other.meta.last_row_id);

    try {
      const response = await workerFetch(`/auth/listing-records/${otherId}`, {
        method: 'DELETE',
        headers: mutationHeaders(agent),
      });
      expect(response.status).toBe(403);
      expect(await testEnv.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(otherId).first()).not.toBeNull();
    } finally {
      await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(otherId).run();
    }
  });

  it('requires an authenticated session and matching CSRF token', async () => {
    const response = await workerFetch('/auth/listing-records/1', { method: 'DELETE' });
    expect([401, 403]).toContain(response.status);
  });
});
