import { authRoutes, authenticateRequest, requireAuth, requireRole } from './auth';
import { sanitizePositiveInt } from './utils';
import {
  emailFingerprint,
  enforceFeedbackRateLimit,
  feedbackWriteRequestError,
  findReviewerSession,
  maskReviewerEmail,
  normalizeEmail,
  sanitizeFeedbackText,
  validateRatingComment,
  validateReviewerCsrf,
  type FeedbackBindings,
  type ReviewerSession,
} from './feedback-policy';
import './feedback-auth-routes';

const REPORT_REASONS = new Set([
  'misleading_information',
  'suspected_fraud',
  'impersonation',
  'property_unavailable',
  'incorrect_price',
  'duplicate_listing',
  'harassment',
  'unauthorised_agent',
  'other',
]);

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

function envFor(c: any): FeedbackBindings {
  return c.env as FeedbackBindings;
}

function noStore(c: any): void {
  c.header('Cache-Control', 'no-store');
}

function requestIp(c: any): string {
  return c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')
    || 'unknown';
}

async function requireReviewerWrite(
  c: any,
  routeKey: string,
  burstLimit: number,
): Promise<ReviewerSession | Response> {
  const env = envFor(c);
  const requestError = feedbackWriteRequestError(c.req.raw, env);
  if (requestError) return c.json({ success: false, message: requestError }, 403);

  const limited = await enforceFeedbackRateLimit(
    env,
    `feedback:${routeKey}:${requestIp(c)}`,
    burstLimit,
  );
  if (!limited.allowed) {
    c.header('Retry-After', String(limited.retryAfter));
    return c.json({ success: false, message: 'Too many submissions. Please try again later.' }, 429);
  }

  const session = await findReviewerSession(c.req.raw, env);
  if (!session) return c.json({ success: false, message: 'Continue with Google to submit feedback.' }, 401);
  if (!await validateReviewerCsrf(c.req.raw, session)) {
    return c.json({ success: false, message: 'CSRF token mismatch.' }, 403);
  }
  if (session.banned) return c.json({ success: false, message: 'This reviewer account cannot submit feedback.' }, 403);
  if (session.professionalConflict) {
    return c.json({ success: false, message: 'Professional PrimeProp accounts cannot rate agents.' }, 403);
  }

  const professional = await authenticateRequest(c);
  if (professional) {
    return c.json({
      success: false,
      message: 'Sign out of the administrator or agent account before submitting public feedback.',
    }, 403);
  }

  return session;
}

async function ratingSource(
  env: FeedbackBindings,
  agentId: number,
  listingId: number,
): Promise<{ agentName: string; listingTitle: string } | null> {
  const row = await env.DB.prepare(
    `SELECT agent.name AS agent_name, listing.title AS listing_title
     FROM users agent
     JOIN listings listing ON listing.created_by = agent.id
     WHERE agent.id = ?
       AND listing.id = ?
       AND agent.role = 'agent'
       AND COALESCE(agent.account_status, 'active') = 'active'
       AND COALESCE(agent.profile_published, 0) = 1
       AND listing.approval_status = 'approved'`,
  ).bind(agentId, listingId).first<{ agent_name: string; listing_title: string }>();
  return row ? { agentName: row.agent_name, listingTitle: row.listing_title } : null;
}

function publicRatingWhere(): string {
  return `rating.agent_user_id = ?
    AND rating.rating_status = 'approved'
    AND agent.role = 'agent'
    AND COALESCE(agent.account_status, 'active') = 'active'
    AND COALESCE(agent.profile_published, 0) = 1
    AND source.approval_status = 'approved'
    AND source.created_by = rating.agent_user_id
    AND NOT EXISTS (
      SELECT 1 FROM reviewer_bans ban
      WHERE ban.active = 1
        AND (
          ban.reviewer_id = reviewer.id
          OR (ban.google_sub IS NOT NULL AND ban.google_sub = reviewer.google_sub)
          OR (ban.email_hash IS NOT NULL AND ban.email_hash = reviewer.email_hash)
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM users professional
      WHERE professional.google_id = reviewer.google_sub
         OR lower(professional.email) = reviewer.email_normalized
    )`;
}

authRoutes.get('/feedback/listings/:id/context', async c => {
  noStore(c);
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Listing not found.' }, 404);

  const row = await envFor(c).DB.prepare(
    `SELECT listing.id, listing.title, listing.created_by,
            agent.name AS agent_name,
            CASE WHEN agent.id IS NOT NULL
                      AND agent.role = 'agent'
                      AND COALESCE(agent.account_status, 'active') = 'active'
                      AND COALESCE(agent.profile_published, 0) = 1
                 THEN 1 ELSE 0 END AS rateable
     FROM listings listing
     LEFT JOIN users agent ON agent.id = listing.created_by
     WHERE listing.id = ?
       AND listing.approval_status = 'approved'`,
  ).bind(id).first<{
    id: number;
    title: string;
    created_by: number | null;
    agent_name: string | null;
    rateable: number;
  }>();
  if (!row) return c.json({ success: false, message: 'Listing not found.' }, 404);

  return c.json({
    success: true,
    data: {
      listingId: row.id,
      listingTitle: row.title,
      reportable: true,
      rateable: Boolean(row.rateable),
      agentId: row.rateable ? Number(row.created_by) : null,
      agentName: row.rateable ? String(row.agent_name || '') : '',
    },
  });
});

authRoutes.get('/feedback/agents/:id/ratings', async c => {
  noStore(c);
  const env = envFor(c);
  const agentId = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!agentId) return c.json({ success: false, message: 'Agent not found.' }, 404);

  const agent = await env.DB.prepare(
    `SELECT id, name FROM users
     WHERE id = ? AND role = 'agent'
       AND COALESCE(account_status, 'active') = 'active'
       AND COALESCE(profile_published, 0) = 1`,
  ).bind(agentId).first<{ id: number; name: string }>();
  if (!agent) return c.json({ success: false, message: 'Agent not found.' }, 404);

  const page = sanitizePositiveInt(c.req.query('page'), 1, 1, 1000);
  const limit = sanitizePositiveInt(c.req.query('limit'), 10, 1, 25);
  const offset = (page - 1) * limit;
  const where = publicRatingWhere();

  const aggregate = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(AVG(rating.score), 0) AS average,
            SUM(CASE WHEN rating.score = 5 THEN 1 ELSE 0 END) AS five,
            SUM(CASE WHEN rating.score = 4 THEN 1 ELSE 0 END) AS four,
            SUM(CASE WHEN rating.score = 3 THEN 1 ELSE 0 END) AS three,
            SUM(CASE WHEN rating.score = 2 THEN 1 ELSE 0 END) AS two,
            SUM(CASE WHEN rating.score = 1 THEN 1 ELSE 0 END) AS one
     FROM agent_ratings rating
     JOIN reviewer_identities reviewer ON reviewer.id = rating.reviewer_id
     JOIN users agent ON agent.id = rating.agent_user_id
     JOIN listings source ON source.id = rating.source_listing_id
     WHERE ${where}`,
  ).bind(agentId).first<{
    total: number;
    average: number;
    five: number;
    four: number;
    three: number;
    two: number;
    one: number;
  }>();

  const total = Number(aggregate?.total || 0);
  const comments = await env.DB.prepare(
    `SELECT rating.score, rating.comment, rating.submitted_at,
            reviewer.email_normalized
     FROM agent_ratings rating
     JOIN reviewer_identities reviewer ON reviewer.id = rating.reviewer_id
     JOIN users agent ON agent.id = rating.agent_user_id
     JOIN listings source ON source.id = rating.source_listing_id
     WHERE ${where}
       AND rating.comment_status = 'approved'
       AND rating.comment <> ''
     ORDER BY rating.submitted_at DESC, rating.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
  ).bind(agentId).all();

  const totalPages = Math.ceil(total / limit) || 1;
  return c.json({
    success: true,
    data: {
      agentId,
      agentName: agent.name,
      average: Math.round(Number(aggregate?.average || 0) * 10) / 10,
      total,
      distribution: {
        5: Number(aggregate?.five || 0),
        4: Number(aggregate?.four || 0),
        3: Number(aggregate?.three || 0),
        2: Number(aggregate?.two || 0),
        1: Number(aggregate?.one || 0),
      },
      page,
      limit,
      totalPages,
      comments: (comments.results || []).map((row: any) => ({
        score: Number(row.score),
        comment: String(row.comment || ''),
        reviewerLabel: maskReviewerEmail(String(row.email_normalized || '')),
        submittedAt: String(row.submitted_at || ''),
      })),
    },
  });
});

authRoutes.post('/feedback/ratings', async c => {
  noStore(c);
  const sessionOrResponse = await requireReviewerWrite(c, 'rating', 3);
  if (sessionOrResponse instanceof Response) return sessionOrResponse;
  const session = sessionOrResponse;
  const env = envFor(c);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ success: false, message: 'Invalid request.' }, 400);

  const agentId = sanitizePositiveInt(body.agentId, 0, 1, Number.MAX_SAFE_INTEGER);
  const listingId = sanitizePositiveInt(body.listingId, 0, 1, Number.MAX_SAFE_INTEGER);
  const score = sanitizePositiveInt(body.score, 0, 1, 5);
  const commentResult = validateRatingComment(body.comment);
  if (!agentId || !listingId || !score) {
    return c.json({ success: false, message: 'Agent, source listing and score are required.' }, 400);
  }
  if (commentResult.error) return c.json({ success: false, message: commentResult.error }, 400);

  const source = await ratingSource(env, agentId, listingId);
  if (!source) {
    return c.json({
      success: false,
      message: 'Ratings require an approved listing owned by the selected registered agent.',
    }, 409);
  }

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM agent_ratings
     WHERE reviewer_id = ?
       AND updated_at >= datetime('now', '-1 day')`,
  ).bind(session.reviewerId).first<{ count: number }>();
  if (Number(recent?.count || 0) >= 5) {
    return c.json({ success: false, message: 'Daily rating limit reached.' }, 429);
  }

  const existing = await env.DB.prepare(
    `SELECT id, public_id, rating_status, revision_count
     FROM agent_ratings
     WHERE reviewer_id = ? AND agent_user_id = ?`,
  ).bind(session.reviewerId, agentId).first<{
    id: number;
    public_id: string;
    rating_status: string;
    revision_count: number;
  }>();
  if (existing?.rating_status === 'removed') {
    return c.json({ success: false, message: 'This rating was removed by moderation and is locked.' }, 409);
  }
  if (Number(existing?.revision_count || 0) >= 5) {
    return c.json({ success: false, message: 'This rating has reached its revision limit.' }, 409);
  }

  const commentStatus = commentResult.value ? 'pending' : 'none';
  const publicId = existing?.public_id || crypto.randomUUID();
  const action = existing ? 'feedback.rating.revised' : 'feedback.rating.submitted';
  const auditDetails = JSON.stringify({
    publicId,
    agentId,
    listingId,
    score,
    hasComment: Boolean(commentResult.value),
  });

  if (existing) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE agent_ratings
         SET source_listing_id = ?, score = ?, comment = ?,
             rating_status = 'pending', comment_status = ?,
             revision_count = revision_count + 1,
             updated_at = datetime('now'), moderated_by = NULL,
             moderated_at = NULL, moderation_note = '', removed_at = NULL
         WHERE id = ?`,
      ).bind(listingId, score, commentResult.value, commentStatus, existing.id),
      env.DB.prepare(
        `INSERT INTO audit_events
         (actor_email, action, target_type, target_id, details, request_id, ip_address)
         VALUES (?, ?, 'agent_rating', ?, ?, ?, ?)`,
      ).bind(
        session.email,
        action,
        existing.id,
        auditDetails,
        c.req.header('CF-Ray') || '',
        requestIp(c),
      ),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO agent_ratings
         (public_id, reviewer_id, agent_user_id, source_listing_id,
          score, comment, rating_status, comment_status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      ).bind(
        publicId,
        session.reviewerId,
        agentId,
        listingId,
        score,
        commentResult.value,
        commentStatus,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
         (actor_email, action, target_type, details, request_id, ip_address)
         VALUES (?, ?, 'agent_rating', ?, ?, ?)`,
      ).bind(
        session.email,
        action,
        auditDetails,
        c.req.header('CF-Ray') || '',
        requestIp(c),
      ),
    ]);
  }

  return c.json({
    success: true,
    message: 'Your rating was submitted for administrator review.',
    data: { publicId, status: 'pending' },
  }, 202);
});

authRoutes.post('/feedback/reports', async c => {
  noStore(c);
  const sessionOrResponse = await requireReviewerWrite(c, 'report', 5);
  if (sessionOrResponse instanceof Response) return sessionOrResponse;
  const session = sessionOrResponse;
  const env = envFor(c);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return c.json({ success: false, message: 'Invalid request.' }, 400);

  const targetType = body.targetType === 'agent' ? 'agent' : body.targetType === 'listing' ? 'listing' : '';
  const targetId = sanitizePositiveInt(body.targetId, 0, 1, Number.MAX_SAFE_INTEGER);
  const reasonCode = typeof body.reasonCode === 'string' ? body.reasonCode : '';
  const details = sanitizeFeedbackText(body.details, 1500);
  if (!targetType || !targetId || !REPORT_REASONS.has(reasonCode)) {
    return c.json({ success: false, message: 'Target and report reason are required.' }, 400);
  }
  if (reasonCode === 'other' && details.length < 20) {
    return c.json({ success: false, message: 'Please explain the issue in at least 20 characters.' }, 400);
  }

  let targetName = '';
  if (targetType === 'listing') {
    const listing = await env.DB.prepare(
      `SELECT title FROM listings
       WHERE id = ? AND approval_status = 'approved'`,
    ).bind(targetId).first<{ title: string }>();
    if (!listing) return c.json({ success: false, message: 'Listing not found.' }, 404);
    targetName = listing.title;
  } else {
    const agent = await env.DB.prepare(
      `SELECT name FROM users
       WHERE id = ? AND role = 'agent'
         AND COALESCE(account_status, 'active') = 'active'
         AND COALESCE(profile_published, 0) = 1`,
    ).bind(targetId).first<{ name: string }>();
    if (!agent) return c.json({ success: false, message: 'Agent not found.' }, 404);
    targetName = agent.name;
  }

  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM moderation_reports
     WHERE reporter_reviewer_id = ?
       AND submitted_at >= datetime('now', '-1 day')`,
  ).bind(session.reviewerId).first<{ count: number }>();
  if (Number(recent?.count || 0) >= 10) {
    return c.json({ success: false, message: 'Daily report limit reached.' }, 429);
  }

  const duplicateSql = targetType === 'listing'
    ? `SELECT id FROM moderation_reports
       WHERE reporter_reviewer_id = ? AND target_type = 'listing'
         AND listing_id = ? AND reason_code = ?
         AND status IN ('pending', 'investigating')
         AND submitted_at >= datetime('now', '-7 days') LIMIT 1`
    : `SELECT id FROM moderation_reports
       WHERE reporter_reviewer_id = ? AND target_type = 'agent'
         AND agent_user_id = ? AND reason_code = ?
         AND status IN ('pending', 'investigating')
         AND submitted_at >= datetime('now', '-7 days') LIMIT 1`;
  const duplicate = await env.DB.prepare(duplicateSql)
    .bind(session.reviewerId, targetId, reasonCode).first();
  if (duplicate) {
    return c.json({ success: false, message: 'You already submitted this report recently.' }, 409);
  }

  const publicId = crypto.randomUUID();
  const listingId = targetType === 'listing' ? targetId : null;
  const agentId = targetType === 'agent' ? targetId : null;
  const auditDetails = JSON.stringify({ publicId, targetType, targetId, reasonCode });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO moderation_reports
       (public_id, reporter_reviewer_id, target_type, listing_id,
        agent_user_id, reason_code, details)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(publicId, session.reviewerId, targetType, listingId, agentId, reasonCode, details),
    env.DB.prepare(
      `INSERT INTO audit_events
       (actor_email, action, target_type, details, request_id, ip_address)
       VALUES (?, 'feedback.report.submitted', 'moderation_report', ?, ?, ?)`,
    ).bind(
      session.email,
      auditDetails,
      c.req.header('CF-Ray') || '',
      requestIp(c),
    ),
  ]);

  return c.json({
    success: true,
    message: `Your report about ${targetName} was submitted for review.`,
    data: { publicId, status: 'pending' },
  }, 202);
});

authRoutes.get('/feedback/admin/overview', requireAuth, requireRole('admin'), async c => {
  noStore(c);
  const env = envFor(c);
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
  noStore(c);
  const env = envFor(c);
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
  noStore(c);
  const env = envFor(c);
  const admin = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : '';
  const note = sanitizeFeedbackText(body?.note, 500);
  if (!id || !RATING_ACTIONS.has(action)) {
    return c.json({ success: false, message: 'Invalid moderation action.' }, 400);
  }
  const rating = await env.DB.prepare(
    `SELECT id, comment, rating_status, comment_status FROM agent_ratings WHERE id = ?`,
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
      c.req.header('CF-Ray') || '',
      requestIp(c),
    ),
  ]);
  return c.json({ success: true, message: 'Rating moderation updated.' });
});

authRoutes.get('/feedback/admin/reports', requireAuth, requireRole('admin'), async c => {
  noStore(c);
  const env = envFor(c);
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
  noStore(c);
  const env = envFor(c);
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
  const status = action === 'investigate' ? 'investigating' : action === 'resolve' ? 'resolved' : 'dismissed';
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
      c.req.header('CF-Ray') || '',
      requestIp(c),
    ),
  ]);
  return c.json({ success: true, message: 'Report status updated.' });
});

authRoutes.get('/feedback/admin/reviewers', requireAuth, requireRole('admin'), async c => {
  noStore(c);
  const env = envFor(c);
  const rows = await env.DB.prepare(
    `SELECT reviewer.id, reviewer.email_normalized, reviewer.email_verified,
            reviewer.first_authenticated_at, reviewer.last_authenticated_at,
            COUNT(DISTINCT rating.id) AS total_ratings,
            SUM(CASE WHEN rating.rating_status = 'approved' THEN 1 ELSE 0 END) AS approved_ratings,
            SUM(CASE WHEN rating.rating_status = 'pending' THEN 1 ELSE 0 END) AS pending_ratings,
            COUNT(DISTINCT report.id) AS reports_submitted,
            MAX(CASE WHEN ban.active = 1 THEN ban.id ELSE NULL END) AS active_ban_id
     FROM reviewer_identities reviewer
     LEFT JOIN agent_ratings rating ON rating.reviewer_id = reviewer.id
     LEFT JOIN moderation_reports report ON report.reporter_reviewer_id = reviewer.id
     LEFT JOIN reviewer_bans ban ON ban.reviewer_id = reviewer.id AND ban.active = 1
     GROUP BY reviewer.id
     ORDER BY reviewer.last_authenticated_at DESC, reviewer.id DESC`,
  ).all();
  return c.json({ success: true, count: rows.results?.length || 0, data: rows.results || [] });
});

authRoutes.post('/feedback/admin/bans', requireAuth, requireRole('admin'), async c => {
  noStore(c);
  const env = envFor(c);
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

  let reviewer: { id: number; google_sub: string; email_normalized: string; email_hash: string } | null = null;
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
      c.req.header('CF-Ray') || '',
      requestIp(c),
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
  noStore(c);
  const env = envFor(c);
  const admin = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid ban ID.' }, 400);
  const ban = await env.DB.prepare(
    'SELECT id, reviewer_id, email_normalized FROM reviewer_bans WHERE id = ? AND active = 1',
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
      c.req.header('CF-Ray') || '',
      requestIp(c),
    ),
  ]);
  return c.json({
    success: true,
    message: 'Reviewer unbanned. Ratings removed separately remain removed.',
  });
});
