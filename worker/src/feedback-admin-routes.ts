import { authRoutes, requireAuth, requireRole } from './auth';
import { sanitizePositiveInt } from './utils';
import {
  emailFingerprint,
  normalizeEmail,
  sanitizeFeedbackText,
} from './feedback-policy';
import {
  feedbackEnv,
  feedbackRequestIp,
  setFeedbackNoStore,
} from './feedback-route-helpers';

const RATING_ACTIONS = new Set([
  'approve_rating',
  'reject_rating',
  'remove_rating',
  'restore_rating',
  'approve_comment',
  'hide_comment',
  'delete_comment',
]);
const REPORT_ACTIONS = new Set(['investigate', 'resolve', 'dismiss']);

function auditRequestId(c: any): string {
  return c.req.header('CF-Ray') || '';
}

authRoutes.get('/feedback/admin/overview', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const [ratings, reports, reviewers, bans] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN rating_status = 'pending' THEN 1 ELSE 0 END) AS pending
       FROM agent_ratings`,
    ).first<any>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('pending', 'investigating') THEN 1 ELSE 0 END) AS open
       FROM moderation_reports`,
    ).first<any>(),
    env.DB.prepare('SELECT COUNT(*) AS total FROM reviewer_identities').first<any>(),
    env.DB.prepare('SELECT COUNT(*) AS total FROM reviewer_bans WHERE active = 1').first<any>(),
  ]);
  return c.json({
    success: true,
    data: {
      ratings: Number(ratings?.total || 0),
      pendingRatings: Number(ratings?.pending || 0),
      reports: Number(reports?.total || 0),
      openReports: Number(reports?.open || 0),
      reviewers: Number(reviewers?.total || 0),
      activeBans: Number(bans?.total || 0),
    },
  });
});

authRoutes.get('/feedback/admin/ratings', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const page = sanitizePositiveInt(c.req.query('page'), 1, 1, 1000);
  const limit = sanitizePositiveInt(c.req.query('limit'), 50, 1, 100);
  const offset = (page - 1) * limit;
  const status = c.req.query('status') || 'all';
  const allowed = new Set(['all', 'pending', 'approved', 'rejected', 'removed']);
  const selected = allowed.has(status) ? status : 'all';
  const where = selected === 'all' ? '' : 'WHERE rating.rating_status = ?';
  const params = selected === 'all' ? [] : [selected];
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM agent_ratings rating ${where}`,
  ).bind(...params).first<{ count: number }>();
  const rows = await env.DB.prepare(
    `SELECT rating.id, rating.public_id, rating.score, rating.comment,
            rating.rating_status, rating.comment_status, rating.revision_count,
            rating.submitted_at, rating.updated_at, rating.moderation_note,
            reviewer.id AS reviewer_id, reviewer.email_normalized,
            agent.id AS agent_id, agent.name AS agent_name,
            listing.id AS listing_id, listing.title AS listing_title
     FROM agent_ratings rating
     JOIN reviewer_identities reviewer ON reviewer.id = rating.reviewer_id
     JOIN users agent ON agent.id = rating.agent_user_id
     LEFT JOIN listings listing ON listing.id = rating.source_listing_id
     ${where}
     ORDER BY CASE WHEN rating.rating_status = 'pending' THEN 0 ELSE 1 END,
              rating.updated_at DESC, rating.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...params).all();
  const total = Number(count?.count || 0);
  return c.json({
    success: true,
    count: total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    data: rows.results || [],
  });
});

authRoutes.put('/feedback/admin/ratings/:id', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const admin = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const note = sanitizeFeedbackText(body?.note, 500);
  if (!id || !RATING_ACTIONS.has(action)) {
    return c.json({ success: false, message: 'Invalid moderation action.' }, 400);
  }
  const rating = await env.DB.prepare(
    `SELECT id, comment, rating_status, comment_status
     FROM agent_ratings WHERE id = ?`,
  ).bind(id).first<any>();
  if (!rating) return c.json({ success: false, message: 'Rating not found.' }, 404);

  let updateSql = '';
  if (action === 'approve_rating') {
    updateSql = `UPDATE agent_ratings SET rating_status = 'approved', removed_at = NULL,
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  } else if (action === 'reject_rating') {
    updateSql = `UPDATE agent_ratings SET rating_status = 'rejected',
                 comment_status = CASE WHEN comment_status = 'none' THEN 'none' ELSE 'hidden' END,
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  } else if (action === 'remove_rating') {
    updateSql = `UPDATE agent_ratings SET rating_status = 'removed', removed_at = datetime('now'),
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  } else if (action === 'restore_rating') {
    updateSql = `UPDATE agent_ratings SET rating_status = 'pending', removed_at = NULL,
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  } else if (action === 'approve_comment') {
    if (!String(rating.comment || '').trim()) {
      return c.json({ success: false, message: 'This rating has no comment.' }, 409);
    }
    updateSql = `UPDATE agent_ratings SET comment_status = 'approved',
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  } else if (action === 'hide_comment') {
    updateSql = `UPDATE agent_ratings SET comment_status = 'hidden',
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  } else {
    updateSql = `UPDATE agent_ratings SET comment = '', comment_status = 'removed',
                 moderated_by = ?, moderated_at = datetime('now'), moderation_note = ?,
                 updated_at = datetime('now') WHERE id = ?`;
  }

  await env.DB.batch([
    env.DB.prepare(updateSql).bind(admin.id, note, id),
    env.DB.prepare(
      `INSERT INTO audit_events
       (actor_id, actor_email, action, target_type, target_id, details, request_id, ip_address)
       VALUES (?, ?, ?, 'agent_rating', ?, ?, ?, ?)`,
    ).bind(
      admin.id,
      admin.email,
      `feedback.rating.${action}`,
      id,
      JSON.stringify({ note }),
      auditRequestId(c),
      feedbackRequestIp(c),
    ),
  ]);
  return c.json({ success: true, message: 'Rating moderation updated.' });
});

authRoutes.get('/feedback/admin/reports', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const page = sanitizePositiveInt(c.req.query('page'), 1, 1, 1000);
  const limit = sanitizePositiveInt(c.req.query('limit'), 50, 1, 100);
  const offset = (page - 1) * limit;
  const status = c.req.query('status') || 'all';
  const allowed = new Set(['all', 'pending', 'investigating', 'resolved', 'dismissed']);
  const selected = allowed.has(status) ? status : 'all';
  const where = selected === 'all' ? '' : 'WHERE report.status = ?';
  const params = selected === 'all' ? [] : [selected];
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM moderation_reports report ${where}`,
  ).bind(...params).first<{ count: number }>();
  const rows = await env.DB.prepare(
    `SELECT report.id, report.public_id, report.target_type, report.reason_code,
            report.details, report.status, report.submitted_at, report.updated_at,
            report.resolution_note, reviewer.id AS reviewer_id,
            reviewer.email_normalized,
            listing.id AS listing_id, listing.title AS listing_title,
            agent.id AS agent_id, agent.name AS agent_name
     FROM moderation_reports report
     JOIN reviewer_identities reviewer ON reviewer.id = report.reporter_reviewer_id
     LEFT JOIN listings listing ON listing.id = report.listing_id
     LEFT JOIN users agent ON agent.id = report.agent_user_id
     ${where}
     ORDER BY CASE WHEN report.status = 'pending' THEN 0
                   WHEN report.status = 'investigating' THEN 1 ELSE 2 END,
              report.updated_at DESC, report.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...params).all();
  const total = Number(count?.count || 0);
  return c.json({
    success: true,
    count: total,
    page,
    limit,
    totalPages: Math.ceil(total / limit) || 1,
    data: rows.results || [],
  });
});

authRoutes.put('/feedback/admin/reports/:id', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const admin = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const note = sanitizeFeedbackText(body?.note, 1000);
  if (!id || !REPORT_ACTIONS.has(action)) {
    return c.json({ success: false, message: 'Invalid report action.' }, 400);
  }
  const exists = await env.DB.prepare('SELECT id FROM moderation_reports WHERE id = ?').bind(id).first();
  if (!exists) return c.json({ success: false, message: 'Report not found.' }, 404);
  const status = action === 'investigate'
    ? 'investigating'
    : action === 'resolve'
      ? 'resolved'
      : 'dismissed';
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE moderation_reports
       SET status = ?, resolution_note = ?, handled_by = ?,
           handled_at = datetime('now'), updated_at = datetime('now')
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
      JSON.stringify({ note }),
      auditRequestId(c),
      feedbackRequestIp(c),
    ),
  ]);
  return c.json({ success: true, message: 'Report status updated.' });
});

authRoutes.get('/feedback/admin/reviewers', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const rows = await feedbackEnv(c).DB.prepare(
    `SELECT reviewer.id, reviewer.email_normalized, reviewer.email_verified,
            reviewer.first_authenticated_at, reviewer.last_authenticated_at,
            (SELECT COUNT(*) FROM agent_ratings rating
             WHERE rating.reviewer_id = reviewer.id) AS total_ratings,
            (SELECT COUNT(*) FROM agent_ratings rating
             WHERE rating.reviewer_id = reviewer.id
               AND rating.rating_status = 'approved') AS approved_ratings,
            (SELECT COUNT(*) FROM agent_ratings rating
             WHERE rating.reviewer_id = reviewer.id
               AND rating.rating_status = 'pending') AS pending_ratings,
            (SELECT COUNT(*) FROM moderation_reports report
             WHERE report.reporter_reviewer_id = reviewer.id) AS reports_submitted,
            (SELECT ban.id FROM reviewer_bans ban
             WHERE ban.active = 1
               AND (
                 ban.reviewer_id = reviewer.id
                 OR ban.google_sub = reviewer.google_sub
                 OR ban.email_hash = reviewer.email_hash
               )
             ORDER BY ban.id DESC LIMIT 1) AS active_ban_id
     FROM reviewer_identities reviewer
     ORDER BY reviewer.last_authenticated_at DESC, reviewer.id DESC`,
  ).all();
  return c.json({ success: true, count: rows.results?.length || 0, data: rows.results || [] });
});

authRoutes.post('/feedback/admin/bans', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const admin = c.get('user');
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ success: false, message: 'Invalid request.' }, 400);
  const reviewerId = sanitizePositiveInt(body.reviewerId, 0, 1, Number.MAX_SAFE_INTEGER) || null;
  const submittedEmail = normalizeEmail(body.email);
  const reason = sanitizeFeedbackText(body.reason, 500);
  const removeFeedback = body.removeFeedback === true;
  if (!reviewerId && !submittedEmail) {
    return c.json({ success: false, message: 'Reviewer or email is required.' }, 400);
  }
  if (!reason) return c.json({ success: false, message: 'A ban reason is required.' }, 400);

  let reviewer: {
    id: number;
    google_sub: string;
    email_normalized: string;
    email_hash: string;
  } | null = null;
  if (reviewerId) {
    reviewer = await env.DB.prepare(
      `SELECT id, google_sub, email_normalized, email_hash
       FROM reviewer_identities WHERE id = ?`,
    ).bind(reviewerId).first<any>();
    if (!reviewer) return c.json({ success: false, message: 'Reviewer not found.' }, 404);
  }
  const email = reviewer?.email_normalized || submittedEmail;
  const emailHash = reviewer?.email_hash || await emailFingerprint(email, env.JWT_SECRET);
  const existing = await env.DB.prepare(
    `SELECT id FROM reviewer_bans
     WHERE active = 1
       AND (
         (? IS NOT NULL AND reviewer_id = ?)
         OR (email_hash IS NOT NULL AND email_hash = ?)
       ) LIMIT 1`,
  ).bind(reviewer?.id || null, reviewer?.id || null, emailHash).first();
  if (existing) return c.json({ success: false, message: 'This reviewer or email is already banned.' }, 409);

  const statements = [
    env.DB.prepare(
      `INSERT INTO reviewer_bans
       (reviewer_id, google_sub, email_normalized, email_hash, reason, banned_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      reviewer?.id || null,
      reviewer?.google_sub || null,
      email,
      emailHash,
      reason,
      admin.id,
    ),
    env.DB.prepare(
      `UPDATE reviewer_sessions SET revoked = 1
       WHERE reviewer_id IN (
         SELECT id FROM reviewer_identities
         WHERE (? IS NOT NULL AND id = ?) OR email_hash = ?
       )`,
    ).bind(reviewer?.id || null, reviewer?.id || null, emailHash),
    env.DB.prepare(
      `INSERT INTO audit_events
       (actor_id, actor_email, action, target_type, target_id, details, request_id, ip_address)
       VALUES (?, ?, 'feedback.reviewer.banned', 'reviewer', ?, ?, ?, ?)`,
    ).bind(
      admin.id,
      admin.email,
      reviewer?.id || null,
      JSON.stringify({ email, reason, removeFeedback }),
      auditRequestId(c),
      feedbackRequestIp(c),
    ),
  ];
  if (removeFeedback) {
    statements.splice(2, 0, env.DB.prepare(
      `UPDATE agent_ratings
       SET rating_status = 'removed', removed_at = datetime('now'),
           moderated_by = ?, moderated_at = datetime('now'),
           moderation_note = 'Removed when reviewer was banned',
           updated_at = datetime('now')
       WHERE reviewer_id IN (
         SELECT id FROM reviewer_identities
         WHERE (? IS NOT NULL AND id = ?) OR email_hash = ?
       )`,
    ).bind(admin.id, reviewer?.id || null, reviewer?.id || null, emailHash));
  }
  await env.DB.batch(statements);
  return c.json({ success: true, message: 'Reviewer ban applied.' }, 201);
});

authRoutes.delete('/feedback/admin/bans/:id', requireAuth, requireRole('admin'), async c => {
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
  const admin = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid ban ID.' }, 400);
  const ban = await env.DB.prepare(
    `SELECT id, reviewer_id, email_normalized
     FROM reviewer_bans WHERE id = ? AND active = 1`,
  ).bind(id).first<any>();
  if (!ban) return c.json({ success: false, message: 'Active ban not found.' }, 404);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE reviewer_bans
       SET active = 0, unbanned_by = ?, unbanned_at = datetime('now')
       WHERE id = ?`,
    ).bind(admin.id, id),
    env.DB.prepare(
      `INSERT INTO audit_events
       (actor_id, actor_email, action, target_type, target_id, details, request_id, ip_address)
       VALUES (?, ?, 'feedback.reviewer.unbanned', 'reviewer_ban', ?, ?, ?, ?)`,
    ).bind(
      admin.id,
      admin.email,
      id,
      JSON.stringify({ reviewerId: ban.reviewer_id, email: ban.email_normalized }),
      auditRequestId(c),
      feedbackRequestIp(c),
    ),
  ]);
  return c.json({
    success: true,
    message: 'Reviewer unbanned. Ratings removed separately remain removed.',
  });
});
