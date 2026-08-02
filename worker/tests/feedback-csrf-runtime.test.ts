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

function reviewerWrite(
  reviewerToken: string,
  csrfToken: string,
  staleFeedbackCsrf: string,
  staleProfessionalCsrf: string,
  body: unknown,
): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Feedback ${csrfToken}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Origin: BASE,
      'Sec-Fetch-Site': 'same-origin',
      Cookie: [
        `__Host-pp_feedback_session=${reviewerToken}`,
        `pp_feedback_csrf=${staleFeedbackCsrf}`,
        `pp_csrf=${staleProfessionalCsrf}`,
      ].join('; '),
      'CF-Connecting-IP': '203.0.113.77',
      'CF-IPCountry': 'NG',
      'CF-Ray': `feedback-csrf-${crypto.randomUUID()}`,
      'User-Agent': 'PrimeProp-CSRF-Regression/1.0',
    },
    body: JSON.stringify(body),
  };
}

describe('reviewer CSRF synchronization', () => {
  it('accepts ratings, rating comments and reports despite stale reviewer and professional CSRF cookies', async () => {
    const suffix = crypto.randomUUID();
    const reviewerToken = `csrf-session-${suffix}`;
    const originalCsrf = `csrf-original-${suffix}`;
    const staleFeedbackCsrf = `csrf-stale-feedback-${suffix}`;
    const staleProfessionalCsrf = `csrf-stale-professional-${suffix}`;
    const originalAgent = await testEnv.DB.prepare(
      'SELECT account_status, profile_published FROM users WHERE id = 2',
    ).first<{ account_status: string; profile_published: number }>();
    const listingInsert = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by)
       VALUES (?, 'rent', 'apartment', 3500000, 'CSRF Regression Estate', 'Lagos', 2)`,
    ).bind(`CSRF feedback listing ${suffix}`).run();
    const listingId = Number(listingInsert.meta.last_row_id);
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
      await testEnv.DB.prepare(
        `UPDATE users
         SET account_status = 'active', profile_published = 1
         WHERE id = 2`,
      ).run();
      await testEnv.DB.prepare(
        `UPDATE listings
         SET approval_status = 'approved', approved_by = 1,
             approved_at = datetime('now')
         WHERE id = ?`,
      ).bind(listingId).run();

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
          Cookie: [
            `__Host-pp_feedback_session=${reviewerToken}`,
            `pp_feedback_csrf=${staleFeedbackCsrf}`,
            `pp_csrf=${staleProfessionalCsrf}`,
          ].join('; '),
        },
      });
      expect(synchronized.status).toBe(200);
      expect(synchronized.headers.get('cache-control')).toBe('no-store');
      const body = await synchronized.json() as any;
      expect(body.data.authenticated).toBe(true);
      expect(body.data.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(body.data.csrfToken).not.toBe(staleFeedbackCsrf);
      expect(synchronized.headers.get('set-cookie')).toContain('pp_feedback_csrf=');

      const repairedHash = await testEnv.DB.prepare(
        'SELECT csrf_hash FROM reviewer_sessions WHERE id = ?',
      ).bind(sessionId).first<{ csrf_hash: string }>();
      expect(repairedHash?.csrf_hash).toBe(await sha256Hex(body.data.csrfToken));

      const rating = await workerFetch(
        '/auth/feedback/ratings',
        reviewerWrite(
          reviewerToken,
          body.data.csrfToken,
          staleFeedbackCsrf,
          staleProfessionalCsrf,
          {
            agentId: 2,
            listingId,
            score: 5,
            comment: 'The agent explained the viewing clearly and followed up as promised.',
          },
        ),
      );
      expect(rating.status).toBe(202);
      expect((await rating.json() as any).data.status).toBe('pending');

      const storedRating = await testEnv.DB.prepare(
        `SELECT score, comment, rating_status, comment_status
         FROM agent_ratings
         WHERE reviewer_id = ? AND agent_user_id = 2`,
      ).bind(reviewerId).first<any>();
      expect(storedRating).toMatchObject({
        score: 5,
        rating_status: 'pending',
        comment_status: 'pending',
      });
      expect(storedRating?.comment).toContain('followed up as promised');

      const report = await workerFetch(
        '/auth/feedback/reports',
        reviewerWrite(
          reviewerToken,
          body.data.csrfToken,
          staleFeedbackCsrf,
          staleProfessionalCsrf,
          {
            targetType: 'listing',
            targetId: listingId,
            reasonCode: 'incorrect_price',
            details: 'The amount discussed during the viewing differed from the published price.',
          },
        ),
      );
      expect(report.status).toBe(202);
      expect((await report.json() as any).data.status).toBe('pending');

      const storedReport = await testEnv.DB.prepare(
        `SELECT status, reason_code
         FROM moderation_reports
         WHERE reporter_reviewer_id = ? AND listing_id = ?`,
      ).bind(reviewerId, listingId).first<any>();
      expect(storedReport).toMatchObject({
        status: 'pending',
        reason_code: 'incorrect_price',
      });

      const logout = await workerFetch(
        '/auth/feedback/logout',
        reviewerWrite(
          reviewerToken,
          body.data.csrfToken,
          staleFeedbackCsrf,
          staleProfessionalCsrf,
          {},
        ),
      );
      expect(logout.status).toBe(200);
      expect((await logout.json() as any).success).toBe(true);

      const revoked = await testEnv.DB.prepare(
        'SELECT revoked FROM reviewer_sessions WHERE id = ?',
      ).bind(sessionId).first<{ revoked: number }>();
      expect(revoked?.revoked).toBe(1);
    } finally {
      await testEnv.DB.prepare('DELETE FROM moderation_reports WHERE reporter_reviewer_id = ?')
        .bind(reviewerId).run();
      await testEnv.DB.prepare('DELETE FROM agent_ratings WHERE reviewer_id = ?')
        .bind(reviewerId).run();
      await testEnv.DB.prepare('DELETE FROM reviewer_sessions WHERE reviewer_id = ?')
        .bind(reviewerId).run();
      await testEnv.DB.prepare('DELETE FROM reviewer_identities WHERE id = ?')
        .bind(reviewerId).run();
      await testEnv.DB.prepare('DELETE FROM listings WHERE id = ?')
        .bind(listingId).run();
      if (originalAgent) {
        await testEnv.DB.prepare(
          `UPDATE users SET account_status = ?, profile_published = ? WHERE id = 2`,
        ).bind(originalAgent.account_status, originalAgent.profile_published).run();
      }
    }
  });
});
