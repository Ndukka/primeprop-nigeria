import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const testEnv = env as unknown as { DB: D1Database };

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
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
});
