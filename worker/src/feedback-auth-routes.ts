import { createRemoteJWKSet, jwtVerify } from 'jose';
import { authRoutes } from './auth';
import {
  appendSetCookies,
  clearOauthCookies,
  clearReviewerSessionCookies,
  emailFingerprint,
  enforceFeedbackRateLimit,
  feedbackWriteRequestError,
  findReviewerSession,
  getCookie,
  issueReviewerSession,
  isReviewerBanned,
  maskReviewerEmail,
  normalizeEmail,
  oauthCookies,
  professionalConflict,
  randomBase64Url,
  returnPathWithFeedbackStatus,
  reviewerEmailConflict,
  reviewerSessionCookies,
  revokeReviewerSession,
  safeFeedbackReturnPath,
  sha256Base64Url,
  signFeedbackValue,
  timingSafeEqual,
  validateReviewerCsrf,
  verifyFeedbackValue,
  FEEDBACK_CSRF_COOKIE,
  FEEDBACK_OAUTH_NONCE_COOKIE,
  FEEDBACK_OAUTH_PKCE_COOKIE,
  FEEDBACK_OAUTH_RETURN_COOKIE,
  FEEDBACK_OAUTH_STATE_COOKIE,
  type FeedbackBindings,
} from './feedback-policy';

const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

function envFor(c: any): FeedbackBindings {
  return c.env as FeedbackBindings;
}

function requestIp(c: any): string {
  return c.req.header('CF-Connecting-IP')
    || c.req.header('X-Forwarded-For')
    || 'unknown';
}

function configuredFeedbackRedirect(env: FeedbackBindings): string {
  const value = env.GOOGLE_FEEDBACK_REDIRECT_URI || '';
  if (!value) return '';
  try {
    const url = new URL(value);
    const allowedOrigin = url.origin === 'https://primeprop-worker.ndupsn.workers.dev'
      || url.origin === 'https://primeprop.ng'
      || (env.ENVIRONMENT === 'test' && url.origin === 'https://primeprop.test');
    if (
      url.protocol !== 'https:'
      || !allowedOrigin
      || url.pathname !== '/auth/feedback/google/callback'
      || url.username
      || url.password
      || url.search
      || url.hash
    ) return '';
    return url.toString();
  } catch {
    return '';
  }
}

function relativeRedirect(location: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function redirectWithClearedOauth(returnTo: string, status: string): Response {
  return appendSetCookies(
    relativeRedirect(returnPathWithFeedbackStatus(returnTo, status)),
    clearOauthCookies(),
  );
}

authRoutes.get('/feedback/google', async c => {
  const env = envFor(c);
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const redirectUri = configuredFeedbackRedirect(env);
  if (!clientId || !env.GOOGLE_CLIENT_SECRET || !redirectUri) {
    return c.json({
      success: false,
      message: 'Google reviewer authentication is not configured.',
    }, 503);
  }

  const limit = await enforceFeedbackRateLimit(
    env,
    `feedback:oauth:${requestIp(c)}`,
    10,
  );
  if (!limit.allowed) {
    c.header('Retry-After', String(limit.retryAfter));
    return c.json({ success: false, message: 'Too many sign-in attempts. Please try again later.' }, 429);
  }

  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const verifier = randomBase64Url(64);
  const returnTo = safeFeedbackReturnPath(c.req.query('returnTo'));
  const challenge = await sha256Base64Url(verifier);

  const signed = {
    state: await signFeedbackValue(state, env.JWT_SECRET),
    nonce: await signFeedbackValue(nonce, env.JWT_SECRET),
    verifier: await signFeedbackValue(verifier, env.JWT_SECRET),
    returnTo: await signFeedbackValue(returnTo, env.JWT_SECRET),
  };

  const url = new URL(GOOGLE_AUTHORIZATION_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('prompt', 'select_account');

  return appendSetCookies(c.redirect(url.toString(), 302), oauthCookies(signed));
});

authRoutes.get('/feedback/google/callback', async c => {
  const env = envFor(c);
  const clientId = env.GOOGLE_CLIENT_ID || '';
  const clientSecret = env.GOOGLE_CLIENT_SECRET || '';
  const redirectUri = configuredFeedbackRedirect(env);

  const signedReturn = getCookie(c.req.raw, FEEDBACK_OAUTH_RETURN_COOKIE);
  const returnTo = safeFeedbackReturnPath(
    signedReturn ? await verifyFeedbackValue(signedReturn, env.JWT_SECRET) : '',
  );

  if (!clientId || !clientSecret || !redirectUri) {
    return redirectWithClearedOauth(returnTo, 'configuration-error');
  }

  const query = c.req.query();
  if (query.error || !query.code || !query.state) {
    return redirectWithClearedOauth(returnTo, 'cancelled');
  }

  const signedState = getCookie(c.req.raw, FEEDBACK_OAUTH_STATE_COOKIE);
  const signedNonce = getCookie(c.req.raw, FEEDBACK_OAUTH_NONCE_COOKIE);
  const signedVerifier = getCookie(c.req.raw, FEEDBACK_OAUTH_PKCE_COOKIE);
  const expectedState = signedState
    ? await verifyFeedbackValue(signedState, env.JWT_SECRET)
    : null;
  const expectedNonce = signedNonce
    ? await verifyFeedbackValue(signedNonce, env.JWT_SECRET)
    : null;
  const verifier = signedVerifier
    ? await verifyFeedbackValue(signedVerifier, env.JWT_SECRET)
    : null;

  if (
    !expectedState
    || !expectedNonce
    || !verifier
    || !timingSafeEqual(expectedState, query.state)
  ) {
    return redirectWithClearedOauth(returnTo, 'invalid-state');
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: query.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!tokenResponse.ok) {
    return redirectWithClearedOauth(returnTo, 'token-exchange-failed');
  }

  const tokens = await tokenResponse.json().catch(() => null) as { id_token?: string } | null;
  if (!tokens?.id_token) {
    return redirectWithClearedOauth(returnTo, 'invalid-token');
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(tokens.id_token, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch {
    return redirectWithClearedOauth(returnTo, 'invalid-token');
  }

  const googleSub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = normalizeEmail(payload.email);
  const tokenNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
  if (
    !googleSub
    || !email
    || payload.email_verified !== true
    || !tokenNonce
    || !timingSafeEqual(tokenNonce, expectedNonce)
  ) {
    return redirectWithClearedOauth(returnTo, 'invalid-identity');
  }

  if (await professionalConflict(env.DB, googleSub, email)) {
    return redirectWithClearedOauth(returnTo, 'professional-account');
  }

  const emailHash = await emailFingerprint(email, env.JWT_SECRET);
  let reviewer = await env.DB.prepare(
    `SELECT id, google_sub, email_hash
     FROM reviewer_identities
     WHERE google_sub = ?`,
  ).bind(googleSub).first<{ id: number; google_sub: string; email_hash: string }>();

  if (!reviewer && await reviewerEmailConflict(env.DB, null, emailHash)) {
    return redirectWithClearedOauth(returnTo, 'identity-conflict');
  }

  if (!reviewer) {
    const inserted = await env.DB.prepare(
      `INSERT INTO reviewer_identities
       (google_sub, email_normalized, email_hash, email_verified)
       VALUES (?, ?, ?, 1)`,
    ).bind(googleSub, email, emailHash).run();
    reviewer = {
      id: Number(inserted.meta.last_row_id),
      google_sub: googleSub,
      email_hash: emailHash,
    };
  } else {
    if (reviewer.email_hash !== emailHash
      && await reviewerEmailConflict(env.DB, reviewer.id, emailHash)) {
      return redirectWithClearedOauth(returnTo, 'identity-conflict');
    }
    await env.DB.prepare(
      `UPDATE reviewer_identities
       SET email_normalized = ?, email_hash = ?, email_verified = 1,
           last_authenticated_at = datetime('now'), updated_at = datetime('now')
       WHERE id = ?`,
    ).bind(email, emailHash, reviewer.id).run();
  }

  if (await isReviewerBanned(env.DB, reviewer.id, googleSub, emailHash)) {
    return redirectWithClearedOauth(returnTo, 'banned');
  }

  await env.DB.prepare('UPDATE reviewer_sessions SET revoked = 1 WHERE reviewer_id = ?')
    .bind(reviewer.id).run();
  const session = await issueReviewerSession(env, reviewer.id);
  const response = relativeRedirect(returnPathWithFeedbackStatus(returnTo, 'success'));
  return appendSetCookies(
    appendSetCookies(response, clearOauthCookies()),
    reviewerSessionCookies(session.token, session.csrf),
  );
});

authRoutes.get('/feedback/session', async c => {
  c.header('Cache-Control', 'no-store');
  const session = await findReviewerSession(c.req.raw, envFor(c));
  if (!session) {
    return c.json({ success: true, data: { authenticated: false } });
  }
  return c.json({
    success: true,
    data: {
      authenticated: true,
      reviewerLabel: maskReviewerEmail(session.email),
      expiresAt: session.expiresAt,
      canSubmit: !session.banned && !session.professionalConflict,
      blockedReason: session.banned
        ? 'banned'
        : session.professionalConflict
          ? 'professional-account'
          : '',
    },
  });
});

authRoutes.post('/feedback/logout', async c => {
  const env = envFor(c);
  const requestError = feedbackWriteRequestError(c.req.raw, env);
  if (requestError) return c.json({ success: false, message: requestError }, 403);
  const csrf = getCookie(c.req.raw, FEEDBACK_CSRF_COOKIE);
  if (!csrf || c.req.header('Authorization') !== `Feedback ${csrf}`) {
    return c.json({ success: false, message: 'Reviewer request proof is missing.' }, 403);
  }
  const session = await findReviewerSession(c.req.raw, env);
  if (session && !await validateReviewerCsrf(c.req.raw, session)) {
    return c.json({ success: false, message: 'CSRF token mismatch.' }, 403);
  }
  await revokeReviewerSession(c.req.raw, env);
  return appendSetCookies(
    c.json({ success: true, message: 'Reviewer session ended.' }),
    clearReviewerSessionCookies(),
  );
});
