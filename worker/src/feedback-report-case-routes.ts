import type { D1Database } from '@cloudflare/workers-types';
import { authRoutes, requireAuth, requireRole } from './auth';
import { sanitizePositiveInt } from './utils';
import { sanitizeFeedbackText } from './feedback-policy';
import {
  feedbackEnv,
  feedbackRequestId,
  feedbackRequestIp,
  setFeedbackNoStore,
} from './feedback-route-helpers';

const REPORT_CASE_ACTIONS = new Set([
  'investigate',
  'resolve',
  'dismiss',
  'take_down_listing',
]);
const CLOSED_EVIDENCE_RETENTION_DAYS = 90;

async function purgeExpiredEvidence(db: D1Database): Promise<void> {
  await db.prepare(
    `UPDATE moderation_reports
     SET reporter_ip = NULL,
         reporter_country = NULL,
         reporter_user_agent = NULL,
         request_id = NULL
     WHERE evidence_expires_at IS NOT NULL
       AND evidence_expires_at <= datetime('now')
       AND (
         reporter_ip IS NOT NULL
         OR reporter_country IS NOT NULL
         OR reporter_user_agent IS NOT NULL
         OR request_id IS NOT NULL
       )`,
  ).run();
}

function retentionTimestampSql(): string {
  return `datetime('now', '+${CLOSED_EVIDENCE_RETENTION_DAYS} days')`;
}

authRoutes.get(
  '/feedback/admin/reports/:id/evidence',
  requireAuth,
  requireRole('admin'),
  async c => {
    setFeedbackNoStore(c);
    const env = feedbackEnv(c);
    const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return c.json({ success: false, message: 'Invalid report ID.' }, 400);

    await purgeExpiredEvidence(env.DB);
    const row = await env.DB.prepare(
      `SELECT report.id, report.public_id, report.target_type, report.reason_code,
              report.details, report.status, report.submitted_at, report.updated_at,
              report.resolution_note, report.reporter_email_snapshot,
              report.reporter_email_verified, report.reporter_ip,
              report.reporter_country, report.reporter_user_agent,
              report.request_id, report.evidence_expires_at,
              report.listing_action, report.listing_actioned_at,
              reviewer.email_normalized AS current_reviewer_email,
              reviewer.first_authenticated_at,
              reviewer.last_authenticated_at,
              listing.id AS listing_id, listing.title AS listing_title,
              listing.approval_status AS listing_approval_status,
              owner.name AS listing_owner_name, owner.email AS listing_owner_email,
              agent.id AS agent_id, agent.name AS agent_name,
              handler.name AS handled_by_name, handler.email AS handled_by_email,
              actioner.name AS listing_actioned_by_name,
              actioner.email AS listing_actioned_by_email
       FROM moderation_reports report
       JOIN reviewer_identities reviewer ON reviewer.id = report.reporter_reviewer_id
       LEFT JOIN listings listing ON listing.id = report.listing_id
       LEFT JOIN users owner ON owner.id = listing.created_by
       LEFT JOIN users agent ON agent.id = report.agent_user_id
       LEFT JOIN users handler ON handler.id = report.handled_by
       LEFT JOIN users actioner ON actioner.id = report.listing_actioned_by
       WHERE report.id = ?`,
    ).bind(id).first<any>();
    if (!row) return c.json({ success: false, message: 'Report not found.' }, 404);

    return c.json({
      success: true,
      data: {
        id: row.id,
        publicId: row.public_id,
        targetType: row.target_type,
        reasonCode: row.reason_code,
        details: row.details,
        status: row.status,
        submittedAt: row.submitted_at,
        updatedAt: row.updated_at,
        resolutionNote: row.resolution_note,
        reporter: {
          googleEmail: row.reporter_email_snapshot || row.current_reviewer_email,
          currentGoogleEmail: row.current_reviewer_email,
          emailVerified: Boolean(row.reporter_email_verified),
          firstAuthenticatedAt: row.first_authenticated_at,
          lastAuthenticatedAt: row.last_authenticated_at,
        },
        networkEvidence: {
          ipAddress: row.reporter_ip || null,
          country: row.reporter_country || null,
          userAgent: row.reporter_user_agent || null,
          requestId: row.request_id || null,
          expiresAt: row.evidence_expires_at || null,
          retained: Boolean(
            row.reporter_ip
            || row.reporter_country
            || row.reporter_user_agent
            || row.request_id
          ),
        },
        listing: row.target_type === 'listing' ? {
          id: row.listing_id,
          title: row.listing_title,
          approvalStatus: row.listing_approval_status,
          ownerName: row.listing_owner_name || null,
          ownerEmail: row.listing_owner_email || null,
          action: row.listing_action,
          actionedAt: row.listing_actioned_at,
          actionedByName: row.listing_actioned_by_name || null,
          actionedByEmail: row.listing_actioned_by_email || null,
        } : null,
        agent: row.target_type === 'agent' ? {
          id: row.agent_id,
          name: row.agent_name,
        } : null,
        handledBy: row.handled_by_name || row.handled_by_email ? {
          name: row.handled_by_name || null,
          email: row.handled_by_email || null,
        } : null,
      },
    });
  },
);

authRoutes.put(
  '/feedback/admin/report-cases/:id',
  requireAuth,
  requireRole('admin'),
  async c => {
    setFeedbackNoStore(c);
    const env = feedbackEnv(c);
    const admin = c.get('user');
    const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const action = typeof body?.action === 'string' ? body.action : '';
    const note = sanitizeFeedbackText(body?.note, 1000);
    if (!id || !REPORT_CASE_ACTIONS.has(action)) {
      return c.json({ success: false, message: 'Invalid report action.' }, 400);
    }
    if (action !== 'investigate' && note.length < 10) {
      return c.json({
        success: false,
        message: 'A factual moderation note of at least 10 characters is required.',
      }, 400);
    }

    const report = await env.DB.prepare(
      `SELECT report.id, report.target_type, report.listing_id, report.agent_user_id,
              report.status, listing.title AS listing_title,
              listing.approval_status AS listing_approval_status
       FROM moderation_reports report
       LEFT JOIN listings listing ON listing.id = report.listing_id
       WHERE report.id = ?`,
    ).bind(id).first<any>();
    if (!report) return c.json({ success: false, message: 'Report not found.' }, 404);

    const requestId = feedbackRequestId(c);
    const adminIp = feedbackRequestIp(c);

    if (action === 'take_down_listing') {
      if (report.target_type !== 'listing' || !report.listing_id) {
        return c.json({ success: false, message: 'Only a listing report can take down a listing.' }, 409);
      }
      if (!report.listing_title) {
        return c.json({ success: false, message: 'The reported listing no longer exists.' }, 404);
      }

      const previousApprovalStatus = report.listing_approval_status || 'unknown';
      const details = JSON.stringify({
        reportId: id,
        listingId: report.listing_id,
        note,
        previousApprovalStatus,
        approvalStatus: 'pending',
        evidenceRetentionDays: CLOSED_EVIDENCE_RETENTION_DAYS,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE listings
           SET approval_status = 'pending', approved_by = NULL, approved_at = NULL
           WHERE id = ?`,
        ).bind(report.listing_id),
        env.DB.prepare(
          `UPDATE moderation_reports
           SET status = 'resolved', resolution_note = ?, handled_by = ?,
               handled_at = datetime('now'), updated_at = datetime('now'),
               listing_action = 'taken_down', listing_actioned_at = datetime('now'),
               listing_actioned_by = ?, evidence_expires_at = ${retentionTimestampSql()}
           WHERE id = ?`,
        ).bind(note, admin.id, admin.id, id),
        env.DB.prepare(
          `INSERT INTO audit_events
           (actor_id, actor_email, action, target_type, target_id, details, request_id, ip_address)
           VALUES (?, ?, 'feedback.report.take_down_listing', 'moderation_report', ?, ?, ?, ?)`,
        ).bind(admin.id, admin.email, id, details, requestId, adminIp),
        env.DB.prepare(
          `INSERT INTO audit_events
           (actor_id, actor_email, action, target_type, target_id, details, request_id, ip_address)
           VALUES (?, ?, 'listing.moderation.taken_down', 'listing', ?, ?, ?, ?)`,
        ).bind(admin.id, admin.email, report.listing_id, details, requestId, adminIp),
      ]);

      return c.json({
        success: true,
        message: previousApprovalStatus === 'approved'
          ? 'Listing removed from the public catalogue and report resolved.'
          : 'Report resolved. The listing was already outside the public catalogue.',
        data: {
          reportId: id,
          listingId: report.listing_id,
          previousApprovalStatus,
          approvalStatus: 'pending',
          status: 'resolved',
          evidenceRetentionDays: CLOSED_EVIDENCE_RETENTION_DAYS,
        },
      });
    }

    const status = action === 'investigate'
      ? 'investigating'
      : action === 'resolve'
        ? 'resolved'
        : 'dismissed';
    const expirySql = action === 'investigate' ? 'NULL' : retentionTimestampSql();
    const details = JSON.stringify({
      note,
      status,
      evidenceRetentionDays: action === 'investigate' ? null : CLOSED_EVIDENCE_RETENTION_DAYS,
    });
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE moderation_reports
         SET status = ?, resolution_note = ?, handled_by = ?,
             handled_at = datetime('now'), updated_at = datetime('now'),
             evidence_expires_at = ${expirySql}
         WHERE id = ?`,
      ).bind(status, note, admin.id, id),
      env.DB.prepare(
        `INSERT INTO audit_events
         (actor_id, actor_email, action, target_type, target_id, details, request_id, ip_address)
         VALUES (?, ?, ?, 'moderation_report', ?, ?, ?, ?)`,
      ).bind(
        admin.id,
        admin.email,
        `feedback.report.${action}`,
        id,
        details,
        requestId,
        adminIp,
      ),
    ]);
    return c.json({
      success: true,
      message: 'Report status updated.',
      data: {
        reportId: id,
        status,
        evidenceRetentionDays: action === 'investigate'
          ? null
          : CLOSED_EVIDENCE_RETENTION_DAYS,
      },
    });
  },
);
