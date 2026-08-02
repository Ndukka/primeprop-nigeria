import { authRoutes } from './auth';
import { sanitizePositiveInt } from './utils';
import { maskReviewerEmail } from './feedback-policy';
import {
  feedbackEnv,
  publicRatingWhereClause,
  setFeedbackNoStore,
} from './feedback-route-helpers';

authRoutes.get('/feedback/listings/:id/context', async c => {
  setFeedbackNoStore(c);
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Listing not found.' }, 404);

  const row = await feedbackEnv(c).DB.prepare(
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
  setFeedbackNoStore(c);
  const env = feedbackEnv(c);
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
  const where = publicRatingWhereClause();

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

  const commentCount = await env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM agent_ratings rating
     JOIN reviewer_identities reviewer ON reviewer.id = rating.reviewer_id
     JOIN users agent ON agent.id = rating.agent_user_id
     JOIN listings source ON source.id = rating.source_listing_id
     WHERE ${where}
       AND rating.comment_status = 'approved'
       AND rating.comment <> ''`,
  ).bind(agentId).first<{ total: number }>();
  const totalComments = Number(commentCount?.total || 0);

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

  return c.json({
    success: true,
    data: {
      agentId,
      agentName: agent.name,
      average: Math.round(Number(aggregate?.average || 0) * 10) / 10,
      total: Number(aggregate?.total || 0),
      distribution: {
        5: Number(aggregate?.five || 0),
        4: Number(aggregate?.four || 0),
        3: Number(aggregate?.three || 0),
        2: Number(aggregate?.two || 0),
        1: Number(aggregate?.one || 0),
      },
      page,
      limit,
      totalPages: Math.ceil(totalComments / limit) || 1,
      comments: (comments.results || []).map((row: any) => ({
        score: Number(row.score),
        comment: String(row.comment || ''),
        reviewerLabel: maskReviewerEmail(String(row.email_normalized || '')),
        submittedAt: String(row.submitted_at || ''),
      })),
    },
  });
});
