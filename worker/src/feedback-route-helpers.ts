import {
  enforceFeedbackRateLimit,
  feedbackWriteRequestError,
  findReviewerSession,
  getCookie,
  validateReviewerCsrf,
  FEEDBACK_CSRF_COOKIE,
  type FeedbackBindings,
  type ReviewerSession,
} from './feedback-policy';

export function feedbackEnv(c: any): FeedbackBindings {
  return c.env as FeedbackBindings;
}

export function setFeedbackNoStore(c: any): void {
  c.header('Cache-Control', 'no-store');
}

export function feedbackRequestIp(c: any): string {
  return c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')
    || 'unknown';
}

function hasProfessionalSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('Cookie') || '';
  return /(?:^|;\s*)pp_(?:session|refresh)=/.test(cookie);
}

function hasReviewerAuthorizationProof(request: Request): boolean {
  const csrf = getCookie(request, FEEDBACK_CSRF_COOKIE);
  const authorization = request.headers.get('Authorization') || '';
  return Boolean(csrf) && authorization === `Feedback ${csrf}`;
}

export async function requireReviewerWrite(
  c: any,
  routeKey: string,
  burstLimit: number,
): Promise<ReviewerSession | Response> {
  const env = feedbackEnv(c);
  const requestError = feedbackWriteRequestError(c.req.raw, env);
  if (requestError) return c.json({ success: false, message: requestError }, 403);
  if (!hasReviewerAuthorizationProof(c.req.raw)) {
    return c.json({ success: false, message: 'Reviewer request proof is missing.' }, 403);
  }

  const limited = await enforceFeedbackRateLimit(
    env,
    `feedback:${routeKey}:${feedbackRequestIp(c)}`,
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
  if (session.banned) {
    return c.json({ success: false, message: 'This reviewer account cannot submit feedback.' }, 403);
  }
  if (session.professionalConflict || hasProfessionalSessionCookie(c.req.raw)) {
    return c.json({
      success: false,
      message: 'Administrator and agent accounts cannot submit public agent ratings.',
    }, 403);
  }

  return session;
}

export async function eligibleRatingSource(
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

export function publicRatingWhereClause(): string {
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
