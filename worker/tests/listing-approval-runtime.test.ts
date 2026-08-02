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

function mutationHeaders(session: LoginSession, json = false): HeadersInit {
  return {
    Cookie: session.cookies,
    Origin: BASE,
    'X-CSRF-Token': session.csrf,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function publicTotal(): Promise<number> {
  const response = await workerFetch('/api/stats');
  expect(response.status).toBe(200);
  const body = await response.json() as { data: { total: number } };
  return body.data.total;
}

async function setUserStatus(admin: LoginSession, userId: number, accountStatus: 'active' | 'banned') {
  return workerFetch(`/auth/users/${userId}`, {
    method: 'PUT',
    headers: mutationHeaders(admin, true),
    body: JSON.stringify({ account_status: accountStatus }),
  });
}

function listingBody(title: string) {
  return {
    title,
    type: 'rent',
    propertyType: 'service-apartment',
    price: 2400000,
    priceUnit: '/ year',
    location: 'Approval Test, Lagos',
    area: 'Approval Test',
    city: 'Lagos',
    bedrooms: 2,
    bathrooms: 2,
    description: 'Approval lifecycle fixture.',
    amenities: ['Security'],
    images: [],
    approvalStatus: 'approved',
    approval_status: 'approved',
    approved_by: 1,
    approved_at: new Date().toISOString(),
  };
}

describe.sequential('administrator-controlled listing publication', () => {
  it('keeps every agent submission private until an administrator approves it', async () => {
    const agent = await loginSession('test-agent@primeprop.invalid', 'TestAgent123!');
    const admin = await loginSession('test-admin@primeprop.invalid', 'TestAdmin123!');
    const baselineTotal = await publicTotal();
    const title = `Pending approval ${crypto.randomUUID()}`;
    let listingId = 0;

    try {
      // Use the legacy public write path deliberately. production-entry must
      // route it through the same guarded listing-record handler.
      const create = await workerFetch('/api/listings', {
        method: 'POST',
        headers: mutationHeaders(agent, true),
        body: JSON.stringify(listingBody(title)),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as {
        success: boolean;
        data: { id: number; approvalStatus: string };
      };
      expect(created.success).toBe(true);
      expect(created.data.approvalStatus).toBe('pending');
      listingId = created.data.id;

      const storedPending = await testEnv.DB.prepare(
        'SELECT approval_status, approved_by, approved_at, featured, verified, badge FROM listings WHERE id = ?',
      ).bind(listingId).first<Record<string, unknown>>();
      expect(storedPending).toEqual(expect.objectContaining({
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
        featured: 0,
        verified: 0,
        badge: '',
      }));

      const [detail, contact, search, owned] = await Promise.all([
        workerFetch(`/api/listings/${listingId}`),
        workerFetch(`/auth/listing-contact/${listingId}/whatsapp`, { redirect: 'manual' }),
        workerFetch(`/api/listings?search=${encodeURIComponent(title)}`),
        workerFetch('/auth/my-listings', { headers: { Cookie: agent.cookies } }),
      ]);
      expect(detail.status).toBe(404);
      expect(contact.status).toBe(404);
      const searchBody = await search.json() as { count: number; data: unknown[] };
      expect(searchBody.count).toBe(0);
      expect(searchBody.data).toHaveLength(0);
      const ownedBody = await owned.json() as {
        data: Array<{ id: number; approvalStatus: string }>;
      };
      expect(ownedBody.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: listingId, approvalStatus: 'pending' }),
      ]));
      expect(await publicTotal()).toBe(baselineTotal);

      const agentApproval = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(agent, true),
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      expect(agentApproval.status).toBe(403);

      await expect(
        testEnv.DB.prepare(
          "UPDATE listings SET approval_status = 'approved' WHERE id = ?",
        ).bind(listingId).run(),
      ).rejects.toThrow(/active administrator/i);

      const approve = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      expect(approve.status).toBe(200);
      const approvedBody = await approve.json() as {
        data: { approvalStatus: string; approvedBy: number; approvedAt: string };
      };
      expect(approvedBody.data.approvalStatus).toBe('approved');
      expect(approvedBody.data.approvedBy).toBe(1);
      expect(approvedBody.data.approvedAt).toBeTruthy();

      const [publishedDetail, publishedContact, publishedSearch] = await Promise.all([
        workerFetch(`/api/listings/${listingId}`),
        workerFetch(`/auth/listing-contact/${listingId}/whatsapp`, { redirect: 'manual' }),
        workerFetch(`/api/listings?search=${encodeURIComponent(title)}`),
      ]);
      expect(publishedDetail.status).toBe(200);
      expect(publishedContact.status).toBe(302);
      const publishedSearchBody = await publishedSearch.json() as { count: number };
      expect(publishedSearchBody.count).toBe(1);
      expect(await publicTotal()).toBe(baselineTotal + 1);

      // An agent editing approved factual content must automatically remove the
      // listing from publication until a new administrator review.
      const edit = await workerFetch(`/api/listings/${listingId}`, {
        method: 'PUT',
        headers: mutationHeaders(agent, true),
        body: JSON.stringify({ title: `${title} edited` }),
      });
      expect(edit.status).toBe(200);
      const edited = await edit.json() as { data: { approvalStatus: string } };
      expect(edited.data.approvalStatus).toBe('pending');
      expect((await workerFetch(`/api/listings/${listingId}`)).status).toBe(404);
      expect(await publicTotal()).toBe(baselineTotal);

      const reapprove = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      expect(reapprove.status).toBe(200);

      // Profile identity propagates into listings. That public-facing change is
      // also required to return an approved agent listing to pending.
      const profile = await workerFetch('/auth/profile-settings', {
        method: 'PUT',
        headers: mutationHeaders(agent, true),
        body: JSON.stringify({ agent_title: 'Updated Approval Test Specialist' }),
      });
      expect(profile.status).toBe(200);
      const afterProfile = await testEnv.DB.prepare(
        'SELECT approval_status, approved_by, approved_at FROM listings WHERE id = ?',
      ).bind(listingId).first<Record<string, unknown>>();
      expect(afterProfile).toEqual({
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
      });
      expect((await workerFetch(`/api/listings/${listingId}`)).status).toBe(404);
    } finally {
      if (listingId) {
        await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(listingId).run();
      }
      await testEnv.DB.prepare(
        "UPDATE users SET account_status = 'active', agent_title = 'Service Apartment Specialist' WHERE id = 2",
      ).run();
    }
  });

  it('blocks a banned account and pauses every listing surface until unban', async () => {
    const agent = await loginSession('test-agent@primeprop.invalid', 'TestAgent123!');
    const admin = await loginSession('test-admin@primeprop.invalid', 'TestAdmin123!');
    const baselineTotal = await publicTotal();
    const title = `Suspended owner ${crypto.randomUUID()}`;
    let listingId = 0;

    try {
      const create = await workerFetch('/api/listings', {
        method: 'POST',
        headers: mutationHeaders(agent, true),
        body: JSON.stringify(listingBody(title)),
      });
      expect(create.status).toBe(201);
      listingId = ((await create.json()) as { data: { id: number } }).data.id;

      const approve = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      expect(approve.status).toBe(200);
      expect((await workerFetch(`/api/listings/${listingId}`)).status).toBe(200);
      expect(await publicTotal()).toBe(baselineTotal + 1);

      const ban = await setUserStatus(admin, 2, 'banned');
      expect(ban.status).toBe(200);

      const activeSessions = await testEnv.DB.prepare(
        'SELECT COUNT(*) AS c FROM sessions WHERE user_id = 2 AND revoked = 0',
      ).first<{ c: number }>();
      expect(activeSessions?.c || 0).toBe(0);

      const [owned, detail, contact, search] = await Promise.all([
        workerFetch('/auth/my-listings', { headers: { Cookie: agent.cookies } }),
        workerFetch(`/api/listings/${listingId}`),
        workerFetch(`/auth/listing-contact/${listingId}/whatsapp`, { redirect: 'manual' }),
        workerFetch(`/api/listings?search=${encodeURIComponent(title)}`),
      ]);
      expect(owned.status).toBe(401);
      expect(detail.status).toBe(404);
      expect(contact.status).toBe(404);
      expect(((await search.json()) as { count: number }).count).toBe(0);
      expect(await publicTotal()).toBe(baselineTotal);

      const inventory = await workerFetch('/auth/admin-listings?limit=100', {
        headers: { Cookie: admin.cookies },
      });
      expect(inventory.status).toBe(200);
      const inventoryBody = await inventory.json() as {
        data: Array<{ id: number; approvalStatus: string }>;
      };
      expect(inventoryBody.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: listingId, approvalStatus: 'approved' }),
      ]));

      const pause = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify({ approvalStatus: 'pending' }),
      });
      expect(pause.status).toBe(200);

      const approveWhileBanned = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      expect(approveWhileBanned.status).toBe(409);

      await expect(
        testEnv.DB.prepare(
          `UPDATE listings
           SET approval_status = 'approved', approved_by = 1, approved_at = datetime('now')
           WHERE id = ?`,
        ).bind(listingId).run(),
      ).rejects.toThrow(/owner must be active/i);

      const unban = await setUserStatus(admin, 2, 'active');
      expect(unban.status).toBe(200);
      const publishAgain = await workerFetch(`/auth/admin-listings/${listingId}/approval`, {
        method: 'PUT',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify({ approvalStatus: 'approved' }),
      });
      expect(publishAgain.status).toBe(200);
      expect((await workerFetch(`/api/listings/${listingId}`)).status).toBe(200);
      expect(await publicTotal()).toBe(baselineTotal + 1);
    } finally {
      await testEnv.DB.prepare("UPDATE users SET account_status = 'active' WHERE id = 2").run();
      if (listingId) await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(listingId).run();
    }
  });

  it('normalizes a direct agent-owned insert to pending inside D1', async () => {
    const title = `Direct trigger ${crypto.randomUUID()}`;
    const inserted = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by,
        approval_status, approved_by, approved_at)
       VALUES (?, 'sale', 'duplex', 55000000, 'Trigger Test', 'Lagos', 2,
        'approved', 1, datetime('now'))`,
    ).bind(title).run();
    const id = Number(inserted.meta.last_row_id);

    try {
      const row = await testEnv.DB.prepare(
        'SELECT approval_status, approved_by, approved_at FROM listings WHERE id = ?',
      ).bind(id).first<Record<string, unknown>>();
      expect(row).toEqual({
        approval_status: 'pending',
        approved_by: null,
        approved_at: null,
      });
      expect((await workerFetch(`/api/listings/${id}`)).status).toBe(404);
    } finally {
      await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(id).run();
    }
  });

  it('publishes administrator-created listings immediately', async () => {
    const admin = await loginSession('test-admin@primeprop.invalid', 'TestAdmin123!');
    const title = `Admin publication ${crypto.randomUUID()}`;
    let id = 0;

    try {
      const response = await workerFetch('/api/listings', {
        method: 'POST',
        headers: mutationHeaders(admin, true),
        body: JSON.stringify(listingBody(title)),
      });
      expect(response.status).toBe(201);
      const body = await response.json() as { data: { id: number; approvalStatus: string } };
      id = body.data.id;
      expect(body.data.approvalStatus).toBe('approved');
      expect((await workerFetch(`/api/listings/${id}`)).status).toBe(200);
    } finally {
      if (id) await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(id).run();
    }
  });

  it('cannot suspend or demote the final active administrator', async () => {
    await expect(
      testEnv.DB.prepare("UPDATE users SET account_status = 'banned' WHERE id = 1").run(),
    ).rejects.toThrow(/last active administrator/i);
    await expect(
      testEnv.DB.prepare("UPDATE users SET role = 'agent' WHERE id = 1").run(),
    ).rejects.toThrow(/last active administrator/i);
  });
});
