import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const testEnv = env as unknown as { DB: D1Database };

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('reviewer CSRF synchronization', () => {
  it('repairs a stale readable cookie and accepts the session-bound header proof', async () => {
    const suffix = crypto.randomUUID();
    const reviewerToken = `csrf-session-${suffix}`;
    const originalCsrf = `csrf-original-${suffix}`;
    const staleCsrf = `csrf-stale-${suffix}`;
    const reviewerInsert = await testEnv.DB.prepare(
      `INSERT INTO reviewer_identities
       (google_sub, email_normalized, email_hash, email_verified)
       VALUES (?, ?, ?, 1)`,
    ).bind(
      `csrf-google-${suffix}`,
      `csrf-${suffix}@example.invalid`,
      `csrf-email-hash-${suffix}`,
    ).run();
    const reviewerId = Number(reviewerInsert.meta.last_row_id);

    try {
      const sessionInsert = await testEnv.DB.prepare(
        `INSERT INTO reviewer_sessions
         (reviewer_id, token_hash, csrf_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(
        reviewerId,
        await sha256Hex(reviewerToken),
        await sha256Hex(originalCsrf),
        Date.now() + 60 * 60 * 1000,
      ).run();
      const sessionId = Number(sessionInsert.meta.last_row_id);

      const synchronized = await workerFetch('/auth/feedback/session', {
        headers: {
          Cookie: `__Host-pp_feedback_session=${reviewerToken}; pp_feedback_csrf=${staleCsrf}`,
        },
      });
      expect(synchronized.status).toBe(200);
      expect(synchronized.headers.get('cache-control')).toBe('no-store');
      const body = await synchronized.json() as any;
      expect(body.data.authenticated).toBe(true);
      expect(body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(body.data.csrfToken).not.toBe(staleCsrf);
      expect(synchronized.headers.get('set-cookie')).toContain('pp_feedback_csrf=');

      const repairedHash = await testEnv.DB.prepare(
        'SELECT csrf_hash FROM reviewer_sessions WHERE id = ?',
      ).bind(sessionId).first<{ csrf_hash: string }>();
      expect(repairedHash?.csrf_hash).toBe(await sha256Hex(body.data.csrfToken));

      const logout = await workerFetch('/auth/feedback/logout', {
        method: 'POST',
        headers: {
          Authorization: `Feedback ${body.data.csrfToken}`,
          'Content-Type': 'application/json',
          'X-CSRF-Token': body.data.csrfToken,
          Origin: BASE,
          'Sec-Fetch-Site': 'same-origin',
          Cookie: `__Host-pp_feedback_session=${reviewerToken}; pp_feedback_csrf=${staleCsrf}`,
        },
        body: '{}',
      });
      expect(logout.status).toBe(200);
      expect((await logout.json() as any).success).toBe(true);

      const revoked = await testEnv.DB.prepare(
        'SELECT revoked FROM reviewer_sessions WHERE id = ?',
      ).bind(sessionId).first<{ revoked: number }>();
      expect(revoked?.revoked).toBe(1);
    } finally {
      await testEnv.DB.prepare('DELETE FROM reviewer_sessions WHERE reviewer_id = ?')
        .bind(reviewerId).run();
      await testEnv.DB.prepare('DELETE FROM reviewer_identities WHERE id = ?')
        .bind(reviewerId).run();
    }
  });
});
