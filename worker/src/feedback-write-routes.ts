import { authRoutes } from './auth';
import { sanitizePositiveInt } from './utils';
import { sanitizeFeedbackText, validateRatingComment } from './feedback-policy';
import {
  eligibleRatingSource,
  feedbackEnv,
  feedbackRequestIp,
  requireReviewerWrite,
  setFeedbackNoStore,
} from './feedback-route-helpers';

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

authRoutes.post('/feedback/ratings', async c => {
  setFeedbackNoStore(c);
  const sessionOrResponse = await requireReviewerWrite(c, 'rating', 3);
  if (sessionOrResponse instanceof Response) return sessionOrResponse;
  const session = sessionOrResponse;
  const env = feedbackEnv(c);
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

  const source = await eligibleRatingSource(env, agentId, listingId);
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
        feedbackRequestIp(c),
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
        feedbackRequestIp(c),
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
  setFeedbackNoStore(c);
  const sessionOrResponse = await requireReviewerWrite(c, 'report', 5);
  if (sessionOrResponse instanceof Response) return sessionOrResponse;
  const session = sessionOrResponse;
  const env = feedbackEnv(c);
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
      feedbackRequestIp(c),
    ),
  ]);

  return c.json({
    success: true,
    message: `Your report about ${targetName} was submitted for review.`,
    data: { publicId, status: 'pending' },
  }, 202);
});
