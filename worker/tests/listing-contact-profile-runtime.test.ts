import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const testEnv = env as unknown as { DB: D1Database };

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function login(email: string, password: string): Promise<string> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as any;
  expect(body.success).toBe(true);
  return String(body.data.token);
}

function bearer(token: string, body?: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

describe('live listing contact identity', () => {
  it('prefers the active owner profile over a stale listing phone snapshot', async () => {
    const inserted = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, agent_phone, created_by)
       VALUES (?, 'rent', 'apartment', 2100000, 'Profile Contact Test', 'Lagos', '2348099990000', 2)`,
    ).bind(`Profile contact ${crypto.randomUUID()}`).run();
    const listingId = Number(inserted.meta.last_row_id);

    try {
      await testEnv.DB.prepare(
        `UPDATE listings
         SET approval_status = 'approved', approved_by = 1, approved_at = datetime('now')
         WHERE id = ?`,
      ).bind(listingId).run();

      const [whatsapp, call] = await Promise.all([
        workerFetch(`/auth/listing-contact/${listingId}/whatsapp`, { redirect: 'manual' }),
        workerFetch(`/auth/listing-contact/${listingId}/call`),
      ]);

      expect(whatsapp.status).toBe(302);
      expect(whatsapp.headers.get('location')).toMatch(/^https:\/\/wa\.me\/2348012345678\?text=/);
      expect(whatsapp.headers.get('location')).not.toContain('2348099990000');

      expect(call.status).toBe(200);
      expect(await call.json()).toEqual({
        success: true,
        data: { callUrl: 'tel:+2348012345678' },
      });
    } finally {
      await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?').bind(listingId).run();
    }
  });

  it('supports self-service profile content, admin verification, publication controls, and approved listings only', async () => {
    const original = await testEnv.DB.prepare(
      `SELECT bio, organization_name, organization_role, organization_website,
              organization_address, organization_logo_url, public_email,
              website_url, service_areas, specialties, languages,
              professional_memberships, years_experience, license_body,
              license_number, response_time, office_hours, linkedin_url,
              instagram_url, profile_verified, profile_published
       FROM users WHERE id = 2`,
    ).first<any>();

    const approvedInsert = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by)
       VALUES (?, 'sale', 'duplex', 92000000, 'Public Agent Profile Test', 'Lagos', 2)`,
    ).bind(`Approved profile listing ${crypto.randomUUID()}`).run();
    const pendingInsert = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by)
       VALUES (?, 'rent', 'apartment', 5100000, 'Pending Agent Profile Test', 'Lagos', 2)`,
    ).bind(`Pending profile listing ${crypto.randomUUID()}`).run();
    const approvedId = Number(approvedInsert.meta.last_row_id);
    const pendingId = Number(pendingInsert.meta.last_row_id);

    try {
      await testEnv.DB.prepare(
        `UPDATE listings
         SET approval_status = 'approved', approved_by = 1, approved_at = datetime('now')
         WHERE id = ?`,
      ).bind(approvedId).run();

      const agentToken = await login('test-agent@primeprop.invalid', 'TestAgent123!');
      const selfUpdate = await workerFetch('/auth/profile-settings', bearer(agentToken, {
        bio: 'I help clients compare residential purchases, rentals and land opportunities with clear inspection planning.',
        organization_name: 'PrimeProp Test Realty',
        organization_role: 'Senior Property Consultant',
        organization_website: 'https://agency.example.invalid',
        organization_address: '12 Test Avenue, Lagos',
        public_email: 'ada.public@example.invalid',
        website_url: 'https://ada.example.invalid',
        service_areas: ['Lekki Phase 1', 'Victoria Island'],
        specialties: ['Residential sales', 'Service apartments'],
        languages: ['English', 'Igbo'],
        professional_memberships: ['Test Property Association'],
        years_experience: 8,
        license_body: 'ESVARBON',
        license_number: 'TEST-2048',
        response_time: 'Usually within 2 hours',
        office_hours: 'Monday to Friday, 9:00–17:00',
        linkedin_url: 'https://linkedin.example.invalid/ada',
        instagram_url: 'https://instagram.example.invalid/ada',
        profile_published: true,
        profile_verified: true,
      }));
      expect(selfUpdate.status).toBe(200);
      const selfBody = await selfUpdate.json() as any;
      expect(selfBody.data.profile_verified).toBe(false);
      expect(selfBody.data.organization_name).toBe('PrimeProp Test Realty');
      expect(selfBody.data.service_areas).toEqual(['Lekki Phase 1', 'Victoria Island']);

      const publicBeforeVerification = await workerFetch('/auth/public-agents/2');
      expect(publicBeforeVerification.status).toBe(200);
      const publicBeforeBody = await publicBeforeVerification.json() as any;
      expect(publicBeforeBody.data.name).toBe('Ada Test Agent');
      expect(publicBeforeBody.data.bio).toContain('inspection planning');
      expect(publicBeforeBody.data.organization.name).toBe('PrimeProp Test Realty');
      expect(publicBeforeBody.data.verified).toBe(false);
      expect(publicBeforeBody.data.listings.map((listing: any) => listing.id)).toContain(approvedId);
      expect(publicBeforeBody.data.listings.map((listing: any) => listing.id)).not.toContain(pendingId);
      expect(publicBeforeBody.data.email).toBeUndefined();
      expect(publicBeforeBody.data.account_status).toBeUndefined();
      expect(publicBeforeBody.data.listings[0].agent.id).toBe(2);

      const adminToken = await login('test-admin@primeprop.invalid', 'TestAdmin123!');
      const adminUpdate = await workerFetch('/auth/admin-profile-settings/2', bearer(adminToken, {
        profile_verified: true,
        organization_role: 'Lead Property Consultant',
      }));
      expect(adminUpdate.status).toBe(200);
      const adminBody = await adminUpdate.json() as any;
      expect(adminBody.data.profile_verified).toBe(true);
      expect(adminBody.data.organization_role).toBe('Lead Property Consultant');

      const verifiedPublic = await workerFetch('/auth/public-agents/2');
      expect(verifiedPublic.status).toBe(200);
      expect((await verifiedPublic.json() as any).data.verified).toBe(true);

      const hideProfile = await workerFetch('/auth/profile-settings', bearer(agentToken, {
        profile_published: false,
      }));
      expect(hideProfile.status).toBe(200);
      expect((await workerFetch('/auth/public-agents/2')).status).toBe(404);

      const showProfile = await workerFetch('/auth/profile-settings', bearer(agentToken, {
        profile_published: true,
      }));
      expect(showProfile.status).toBe(200);
      expect((await workerFetch('/auth/public-agents/2')).status).toBe(200);
    } finally {
      await testEnv.DB.prepare('DELETE FROM listings WHERE id IN (?, ?)').bind(approvedId, pendingId).run();
      await testEnv.DB.prepare(
        `UPDATE users SET
           bio = ?, organization_name = ?, organization_role = ?,
           organization_website = ?, organization_address = ?, organization_logo_url = ?,
           public_email = ?, website_url = ?, service_areas = ?, specialties = ?,
           languages = ?, professional_memberships = ?, years_experience = ?,
           license_body = ?, license_number = ?, response_time = ?, office_hours = ?,
           linkedin_url = ?, instagram_url = ?, profile_verified = ?, profile_published = ?
         WHERE id = 2`,
      ).bind(
        original.bio,
        original.organization_name,
        original.organization_role,
        original.organization_website,
        original.organization_address,
        original.organization_logo_url,
        original.public_email,
        original.website_url,
        original.service_areas,
        original.specialties,
        original.languages,
        original.professional_memberships,
        original.years_experience,
        original.license_body,
        original.license_number,
        original.response_time,
        original.office_hours,
        original.linkedin_url,
        original.instagram_url,
        original.profile_verified,
        original.profile_published,
      ).run();
    }
  });
});
