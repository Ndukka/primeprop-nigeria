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
      'CF-Connecting-IP': '192.0.2.10',
      'CF-Ray': 'admin-feedback-test-ray',
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
      'CF-Connecting-IP': '203.0.113.42',
      'X-Forwarded-For': '198.51.100.99',
      'CF-IPCountry': 'NG',
      'CF-Ray': 'reviewer-feedback-test-ray',
      'User-Agent': 'PrimeProp-Test-Browser/1.0',
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
       (title, type, property_type, price, location, city, created_by)
       VALUES (?, 'rent', 'apartment', 4500000, 'Feedback Runtime Estate', 'Lagos', 2)`,
    ).bind(`Feedback listing ${suffix}`).run();
    const legacyInsert = await testEnv.DB.prepare(
      `INSERT INTO listings
       (title, type, property_type, price, location, city, agent_name)
       VALUES (?, 'sale', 'duplex', 85000000, 'Legacy Feedback Estate',
               'Lagos', 'Legacy Catalogue Agent')`,
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
      await testEnv.DB.prepare(
        `UPDATE listings
         SET approval_status = 'approved', approved_by = 1, approved_at = datetime('now')
         WHERE id IN (?, ?)`,
      ).bind(listingId, legacyListingId).run();

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
      const reportBody = await report.json() as any;
      const reportRow = await testEnv.DB.prepare(
        `SELECT id, reporter_ip_hash FROM moderation_reports WHERE public_id = ?`,
      ).bind(reportBody.data.publicId).first<{ id: number; reporter_ip_hash: string }>();
      expect(reportRow?.id).toBeTruthy();
      expect(reportRow?.reporter_ip_hash).toMatch(/^[a-f0-9]{64}$/);

      const evidenceResponse = await workerFetch(
        `/auth/feedback/admin/reports/${reportRow!.id}/evidence`,
        adminWrite(adminToken, 'GET'),
      );
      expect(evidenceResponse.status).toBe(200);
      expect(evidenceResponse.headers.get('cache-control')).toBe('no-store');
      const evidenceText = await evidenceResponse.clone().text();
      const evidenceBody = await evidenceResponse.json() as any;
      expect(evidenceBody.data.reporter).toMatchObject({
        googleEmail: reviewerEmail,
        currentGoogleEmail: reviewerEmail,
        emailVerified: true,
      });
      expect(evidenceBody.data.reporter.firstAuthenticatedAt).toBeTruthy();
      expect(evidenceBody.data.reporter.lastAuthenticatedAt).toBeTruthy();
      expect(evidenceBody.data.networkEvidence).toMatchObject({
        ipAddress: '203.0.113.42',
        country: 'NG',
        userAgent: 'PrimeProp-Test-Browser/1.0',
        requestId: 'reviewer-feedback-test-ray',
        retained: true,
      });
      expect(evidenceBody.data.networkEvidence.ipAddress).not.toBe('198.51.100.99');
      expect(evidenceBody.data.listing).toMatchObject({
        id: listingId,
        approvalStatus: 'approved',
        action: 'none',
      });
      expect(evidenceText).not.toContain(googleSub);
      expect(evidenceText).not.toContain(emailHash);

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
          details: 'This submission should be blocked because the reviewer session was revoked by the ban.',
        },
      ));
      expect(blockedWhileBanned.status).toBe(401);
      expect((await blockedWhileBanned.json() as any).message).toContain('Continue with Google');

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

      const shortTakedownNote = await workerFetch(
        `/auth/feedback/admin/report-cases/${reportRow!.id}`,
        adminWrite(adminToken, 'PUT', { action: 'take_down_listing', note: 'Too short' }),
      );
      expect(shortTakedownNote.status).toBe(400);
      expect((await workerFetch(`/auth/public-listings/${listingId}`)).status).toBe(200);

      const takenDown = await workerFetch(
        `/auth/feedback/admin/report-cases/${reportRow!.id}`,
        adminWrite(adminToken, 'PUT', {
          action: 'take_down_listing',
          note: 'Price evidence requires the listing to remain unpublished during review.',
        }),
      );
      expect(takenDown.status).toBe(200);
      const takenDownBody = await takenDown.json() as any;
      expect(takenDownBody.data).toMatchObject({
        listingId,
        previousApprovalStatus: 'approved',
        approvalStatus: 'pending',
        status: 'resolved',
        evidenceRetentionDays: 90,
      });
      expect((await workerFetch(`/auth/public-listings/${listingId}`)).status).toBe(404);
      expect((await workerFetch(`/auth/public-listings/${legacyListingId}`)).status).toBe(200);
      expect((await (await workerFetch('/auth/feedback/agents/2/ratings')).json() as any).data.total).toBe(0);

      const moderatedState = await testEnv.DB.prepare(
        `SELECT report.status, report.listing_action, report.evidence_expires_at,
                listing.approval_status
         FROM moderation_reports report
         JOIN listings listing ON listing.id = report.listing_id
         WHERE report.id = ?`,
      ).bind(reportRow!.id).first<any>();
      expect(moderatedState).toMatchObject({
        status: 'resolved',
        listing_action: 'taken_down',
        approval_status: 'pending',
      });
      expect(moderatedState.evidence_expires_at).toBeTruthy();

      const reapproved = await workerFetch(
        `/auth/admin-listings/${listingId}/approval`,
        adminWrite(adminToken, 'PUT', { approvalStatus: 'approved' }),
      );
      expect(reapproved.status).toBe(200);
      expect((await workerFetch(`/auth/public-listings/${listingId}`)).status).toBe(200);
      expect((await (await workerFetch('/auth/feedback/agents/2/ratings')).json() as any).data.total).toBe(1);

      await testEnv.DB.prepare(
        `UPDATE moderation_reports
         SET evidence_expires_at = datetime('now', '-1 minute')
         WHERE id = ?`,
      ).bind(reportRow!.id).run();
      const expiredEvidence = await workerFetch(
        `/auth/feedback/admin/reports/${reportRow!.id}/evidence`,
        adminWrite(adminToken, 'GET'),
      );
      expect(expiredEvidence.status).toBe(200);
      const expiredBody = await expiredEvidence.json() as any;
      expect(expiredBody.data.reporter.googleEmail).toBe(reviewerEmail);
      expect(expiredBody.data.networkEvidence).toMatchObject({
        ipAddress: null,
        country: null,
        userAgent: null,
        requestId: null,
        retained: false,
      });
      const retainedFingerprint = await testEnv.DB.prepare(
        `SELECT reporter_ip, reporter_ip_hash FROM moderation_reports WHERE id = ?`,
      ).bind(reportRow!.id).first<any>();
      expect(retainedFingerprint.reporter_ip).toBeNull();
      expect(retainedFingerprint.reporter_ip_hash).toMatch(/^[a-f0-9]{64}$/);

      const audit = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE action LIKE 'feedback.%'
            OR (action = 'listing.moderation.taken_down' AND target_id = ?)`,
      ).bind(listingId).first<{ count: number }>();
      expect(Number(audit?.count || 0)).toBeGreaterThanOrEqual(7);
      const takedownAudits = await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
         WHERE action IN ('feedback.report.take_down_listing', 'listing.moderation.taken_down')
           AND target_id IN (?, ?)`,
      ).bind(reportRow!.id, listingId).first<{ count: number }>();
      expect(Number(takedownAudits?.count || 0)).toBe(2);
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
