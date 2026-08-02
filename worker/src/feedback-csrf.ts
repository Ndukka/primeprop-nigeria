import {
  FEEDBACK_CSRF_COOKIE,
  getCookie,
  randomBase64Url,
  sha256Hex,
  timingSafeEqual,
  type FeedbackBindings,
  type ReviewerSession,
} from './feedback-policy';

const SESSION_SECONDS = 60 * 60;

export type ReviewerCsrfState = {
  token: string;
  setCookie: string | null;
};

function csrfCookie(token: string): string {
  return [
    `${FEEDBACK_CSRF_COOKIE}=${token}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${SESSION_SECONDS}`,
  ].join('; ');
}

export function reviewerRequestProof(request: Request): string {
  const headerToken = request.headers.get('X-CSRF-Token') || '';
  const authorization = request.headers.get('Authorization') || '';
  if (!headerToken || authorization !== `Feedback ${headerToken}`) return '';
  return headerToken;
}

export async function validateSessionCsrf(
  request: Request,
  session: ReviewerSession,
): Promise<boolean> {
  const token = reviewerRequestProof(request);
  if (!token) return false;
  return timingSafeEqual(await sha256Hex(token), session.csrfHash);
}

export async function ensureSessionCsrf(
  request: Request,
  env: FeedbackBindings,
  session: ReviewerSession,
): Promise<ReviewerCsrfState> {
  const cookieToken = getCookie(request, FEEDBACK_CSRF_COOKIE);
  if (cookieToken) {
    const cookieHash = await sha256Hex(cookieToken);
    if (timingSafeEqual(cookieHash, session.csrfHash)) {
      return { token: cookieToken, setCookie: null };
    }
  }

  const token = randomBase64Url(32);
  const csrfHash = await sha256Hex(token);
  const updated = await env.DB.prepare(
    `UPDATE reviewer_sessions
     SET csrf_hash = ?
     WHERE id = ? AND reviewer_id = ? AND revoked = 0 AND expires_at > ?`,
  ).bind(csrfHash, session.sessionId, session.reviewerId, Date.now()).run();

  if (Number(updated.meta.changes || 0) !== 1) {
    throw new Error('Reviewer session could not be synchronized.');
  }

  session.csrfHash = csrfHash;
  return { token, setCookie: csrfCookie(token) };
}
