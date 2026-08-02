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

function adminWrite(token: string, method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function reviewerWrite(token: string, csrf: string, body: unknown, extraCookie = ''): RequestInit {
  const cookie = [
    `__Host-pp_feedback_session=${token}`,
    `pp_feedback_csrf=${csrf}`,
    extraCookie,
  ].filter(Boolean).join('; ');
  return {
    method: 'POST',
    headers: {
      Authorization: `Feedback ${csrf}`,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
      Origin: BASE,
      'Sec-Fetch-Site': 'same-origin',
      Cookie: cookie,
    },
    body: JSON.stringify(body),
  };
}

describe('Google reviewer feedback boundaries', () => {
  it('moderates ratings and reports without exposing reviewer identity publicly', async () => {
    const suffix = crypto.randomUUID();
    const reviewerEmail = `reviewer-${suffix}@example.invalid`;
    const googleSub = `google-reviewer-${suffix}`;
    const emailHash = `test-email-hash-${suffix}`;
    const reviewerToken = `reviewer-token-${suffix}`;
    const reviewerCsrf = `reviewer-csrf-${suffix}`;
    const originalAgent = await testEnv.DB.prepare(
      `SELECT account_status, profile_published FROM users WHERE id = 2`,
    ).first<any>();

    const approvedInsert = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, created_by,
        approval_status, approved_by, approved_at)
       VALUES (?, 'rent', 'apartment', 4500000, 'Feedback Runtime Estate',
               'Lagos', 2, 'approved', 1, datetime('now'))`,
    ).bind(`Feedback listing ${suffix}`).run();
    const legacyInsert = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, agent_name,
        approval_status, approved_by, approved_at)
       VALUES (?, 'sale', 'duplex', 85000000, 'Legacy Feedback Estate',
               'Lagos', 'Legacy Catalogue Agent', 'approved', 1, datetime('now'))`,
    ).bind(`Legacy feedback listing ${suffix}`).run();
    const listingId = Number(approvedInsert.meta.last_row_id);
    const legacyListingId = Number(legacyInsert.meta.last_row_id);

    let reviewerId = 0;
    let professionalId = 0;

    try {
      await testEnv.DB.prepare(
        `UPDATE users
         SET account_status = 'active', profile_published = 1
         WHERE id = 2`,
      ).run();

      const reviewerInsert = await testEnv.DB.prepare(
        `INSERT INTO reviewer_identities
         (google_sub, email_normalized, email_hash, email_verified)
         VALUES (?, ?, ?, 1)`,
      ).bind(googleSub, reviewerEmail, emailHash).run();
      reviewerId = Number(reviewerInsert.meta.last_row_id);
      await testEnv.DB.prepare(
        `INSERT INTO reviewer_sessions
         (reviewer_id, token_hash, csrf_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(
        reviewerId,
        await sha256Hex(reviewerToken),
        await sha256Hex(reviewerCsrf),
        Date.now() + 60 * 60 * 1000,
      ).run();

      const [registeredContext, legacyContext] = await Promise.all([
        workerFetch(`/auth/feedback/listings/${listingId}/context`),
        workerFetch(`/auth/feedback/listings/${legacyListingId}/context`),
      ]);
      expect(registeredContext.status).toBe(200);
      expect((await registeredContext.json() as any).data).toMatchObject({
        rateable: true,
        reportable: true,
        agentId: 2,
      });
      expect(legacyContext.status).toBe(200);
      expect((await legacyContext.json() as any).data).toMatchObject({
        rateable: false,
        reportable: true,
        agentId: null,
      });

      const blockedByProfessionalCookie = await workerFetch(
        '/auth/feedback/ratings',
        reviewerWrite(reviewerToken, reviewerCsrf, {
          agentId: 2,
          listingId,
          score: 5,
          comment: '',
        }, 'pp_session=professional-cookie-present'),
      );
      expect(blockedByProfessionalCookie.status).toBe(403);
      expect((await blockedByProfessionalCookie.json() as any).message).toContain('cannot submit public agent ratings');

      const rejectedPii = await workerFetch('/auth/feedback/ratings', reviewerWrite(
        reviewerToken,
        reviewerCsrf,
        {
          agentId: 2,
          listingId,
          score: 4,
          comment: 'Call me on 08012345678 to discuss this agent.',
        },
      ));
      expect(rejectedPii.status).toBe(400);
      expect((await rejectedPii.json() as any).message).toContain('telephone numbers');

      const submitted = await workerFetch('/auth/feedback/ratings', reviewerWrite(
        reviewerToken,
        reviewerCsrf,
        {
          agentId: 2,
          listingId,
          score: 4,
          comment: 'The agent communicated clearly and arranged the inspection promptly.',
        },
      ));
      expect(submitted.status).toBe(202);
      const submittedBody = await submitted.json() as any;
      expect(submittedBody.data.status).toBe('pending');

      const pendingPublic = await workerFetch('/auth/feedback/agents/2/ratings');
      expect(pendingPublic.status).toBe(200);
      const pendingText = await pendingPublic.clone().text();
      const pendingBody = await pendingPublic.json() as any;
      expect(pendingBody.data.total).toBe(0);
      expect(pendingText).not.toContain(reviewerEmail);
      expect(pendingText).not.toContain(googleSub);
      expect(pendingText).not.toContain(emailHash);

      const rating = await testEnv.DB.prepare(
        `SELECT id FROM agent_ratings
         WHERE reviewer_id = ? AND agent_user_id = 2`,
      ).bind(reviewerId).first<{ id: number }>();
      expect(rating?.id).toBeTruthy();

      const adminToken = await login('test-admin@primeprop.invalid', 'TestAdmin123!');
      const approvedScore = await workerFetch(
        `/auth/feedback/admin/ratings/${rating!.id}`,
        adminWrite(adminToken, 'PUT', { action: 'approve_rating', note: 'Score verified.' }),
      );
      expect(approvedScore.status).toBe(200);
      const approvedComment = await workerFetch(
        `/auth/feedback/admin/ratings/${rating!.id}`,
        adminWrite(adminToken, 'PUT', { action: 'approve_comment', note: 'Comment is publishable.' }),
      );
      expect(approvedComment.status).toBe(200);

      const approvedPublic = await workerFetch('/auth/feedback/agents/2/ratings');
      expect(approvedPublic.status).toBe(200);
      expect(approvedPublic.headers.get('cache-control')).toBe('no-store');
      const approvedText = await approvedPublic.clone().text();
      const approvedBody = await approvedPublic.json() as any;
      expect(approvedBody.data.total).toBe(1);
      expect(approvedBody.data.average).toBe(4);
      expect(approvedBody.data.distribution[4]).toBe(1);
      expect(approvedBody.data.comments).toHaveLength(1);
      expect(approvedBody.data.comments[0].comment).toContain('communicated clearly');
      expect(approvedBody.data.comments[0].reviewerLabel).toContain('•••');
      expect(approvedText).not.toContain(reviewerEmail);
      expect(approvedText).not.toContain(googleSub);
      expect(approvedText).not.toContain(emailHash);
      expect(approvedBody.data.comments[0].email).toBeUndefined();
      expect(approvedBody.data.comments[0].reviewerId).toBeUndefined();

      const report = await workerFetch('/auth/feedback/reports', reviewerWrite(
        reviewerToken,
        reviewerCsrf,
        {
          targetType: 'listing',
          targetId: listingId,
          reasonCode: 'incorrect_price',
          details: 'The price presented during the inspection did not match the published amount.',
        },
      ));
      expect(report.status).toBe(202);
      const duplicateReport = await workerFetch('/auth/feedback/reports', reviewerWrite(
        reviewerToken,
        reviewerCsrf,
        {
          targetType: 'listing',
          targetId: listingId,
          reasonCode: 'incorrect_price',
          details: 'The same issue is still present.',
        },
      ));
      expect(duplicateReport.status).toBe(409);

      const professionalInsert = await testEnv.DB.prepare(
        `INSERT INTO users
         (email, name, role, account_status, security_stamp)
         VALUES (?, 'Reviewer Conflict Agent', 'agent', 'active', ?)`,
      ).bind(reviewerEmail, crypto.randomUUID()).run();
      professionalId = Number(professionalInsert.meta.last_row_id);
      const excludedForProfessional = await workerFetch('/auth/feedback/agents/2/ratings');
      expect((await excludedForProfessional.json() as any).data.total).toBe(0);
      await testEnv.DB.prepare('DELETE FROM users WHERE id = ?').bind(professionalId).run();
      professionalId = 0;
      expect((await (await workerFetch('/auth/feedback/agents/2/ratings')).json() as any).data.total).toBe(1);

      const banned = await workerFetch('/auth/feedback/admin/bans', adminWrite(adminToken, 'POST', {
        reviewerId,
        email: reviewerEmail,
        reason: 'Test moderation ban.',
        removeFeedback: false,
      }));
      expect(banned.status).toBe(201);
      expect((await (await workerFetch('/auth/feedback/agents/2/ratings')).json() as any).data.total).toBe(0);

      const blockedWhileBanned = await workerFetch('/auth/feedback/reports', reviewerWrite(
        reviewerToken,
        reviewerCsrf,
        {
          targetType: 'agent',
          targetId: 2,
          reasonCode: 'other',
          details: 'This submission should be blocked because the reviewer is banned.',
        },
      ));
      expect(blockedWhileBanned.status).toBe(403);

      const ban = await testEnv.DB.prepare(
        `SELECT id FROM reviewer_bans
         WHERE reviewer_id = ? AND active = 1`,
      ).bind(reviewerId).first<{ id: number }>();
      expect(ban?.id).toBeTruthy();
      const unbanned = await workerFetch(
        `/auth/feedback/admin/bans/${ban!.id}`,
        adminWrite(adminToken, 'DELETE'),
      );
      expect(unbanned.status).toBe(200);
      expect((await (await workerFetch('/auth/feedback/agents/2/ratings')).json() as any).data.total).toBe(1);

      const audit = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE action LIKE 'feedback.%'
           AND (target_id = ? OR actor_email = ?)`,
      ).bind(rating!.id, reviewerEmail).first<{ count: number }>();
      expect(Number(audit?.count || 0)).toBeGreaterThanOrEqual(4);
    } finally {
      if (professionalId) {
        await testEnv.DB.prepare('DELETE FROM users WHERE id = ?').bind(professionalId).run();
      }
      if (reviewerId) {
        await testEnv.DB.prepare('DELETE FROM reviewer_bans WHERE reviewer_id = ?').bind(reviewerId).run();
        await testEnv.DB.prepare('DELETE FROM moderation_reports WHERE reporter_reviewer_id = ?').bind(reviewerId).run();
        await testEnv.DB.prepare('DELETE FROM agent_ratings WHERE reviewer_id = ?').bind(reviewerId).run();
        await testEnv.DB.prepare('DELETE FROM reviewer_sessions WHERE reviewer_id = ?').bind(reviewerId).run();
        await testEnv.DB.prepare('DELETE FROM reviewer_identities WHERE id = ?').bind(reviewerId).run();
      }
      await testEnv.DB.prepare('DELETE FROM listings WHERE id IN (?, ?)')
        .bind(listingId, legacyListingId).run();
      await testEnv.DB.prepare(
        `UPDATE users SET account_status = ?, profile_published = ? WHERE id = 2`,
      ).bind(originalAgent.account_status, originalAgent.profile_published).run();
    }
  });
});
