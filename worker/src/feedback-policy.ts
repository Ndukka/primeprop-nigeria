import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';

export type FeedbackBindings = {
  DB: D1Database;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  RATE_LIMITER: DurableObjectNamespace<any>;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_FEEDBACK_REDIRECT_URI?: string;
};

export type ReviewerSession = {
  sessionId: number;
  reviewerId: number;
  googleSub: string;
  email: string;
  emailHash: string;
  csrfHash: string;
  expiresAt: number;
  banned: boolean;
  professionalConflict: boolean;
};

export const FEEDBACK_SESSION_COOKIE = '__Host-pp_feedback_session';
export const FEEDBACK_CSRF_COOKIE = 'pp_feedback_csrf';
export const FEEDBACK_OAUTH_STATE_COOKIE = '__Host-pp_feedback_state';
export const FEEDBACK_OAUTH_NONCE_COOKIE = '__Host-pp_feedback_nonce';
export const FEEDBACK_OAUTH_PKCE_COOKIE = '__Host-pp_feedback_pkce';
export const FEEDBACK_OAUTH_RETURN_COOKIE = '__Host-pp_feedback_return';

const SESSION_SECONDS = 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const PRODUCTION_ORIGINS = new Set([
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
]);
const SAFE_RETURN_PATHS = new Set([
  '/agent-profile',
  '/listing-detail',
  '/listing-detail-1',
  '/listing-detail-2',
  '/listing-detail-3',
  '/properties',
]);

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function randomBase64Url(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export function timingSafeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.byteLength ^ b.byteLength;
  const length = Math.min(a.byteLength, b.byteLength);
  for (let index = 0; index < length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

async function hmacHex(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function emailFingerprint(email: string, secret: string): Promise<string> {
  return hmacHex(`feedback-email:${normalizeEmail(email)}`, secret);
}

export async function signFeedbackValue(value: string, secret: string): Promise<string> {
  return `${value}.${await hmacHex(`feedback-cookie:${value}`, secret)}`;
}

export async function verifyFeedbackValue(value: string, secret: string): Promise<string | null> {
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return null;
  const raw = value.slice(0, separator);
  const expected = await signFeedbackValue(raw, secret);
  return timingSafeEqual(value, expected) ? raw : null;
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function maskReviewerEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email) return 'Google-authenticated reviewer';
  const [local, domain] = email.split('@');
  const domainParts = domain.split('.');
  const domainName = domainParts.shift() || '';
  const suffix = domainParts.length ? `.${domainParts.join('.')}` : '';
  const maskedLocal = local.length <= 2
    ? `${local.slice(0, 1)}•••`
    : `${local[0]}•••${local[local.length - 1]}`;
  const maskedDomain = domainName.length <= 2
    ? `${domainName.slice(0, 1)}•••`
    : `${domainName[0]}•••${domainName[domainName.length - 1]}`;
  return `${maskedLocal}@${maskedDomain}${suffix}`;
}

export function sanitizeFeedbackText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, maxLength);
}

export function validateRatingComment(value: unknown): { value: string; error: string } {
  const comment = sanitizeFeedbackText(value, 1000);
  if (!comment) return { value: '', error: '' };
  if (/[<>]/.test(comment)) {
    return { value: '', error: 'Comments must be plain text.' };
  }
  if (/\bhttps?:\/\/|\bwww\./i.test(comment)) {
    return { value: '', error: 'Comments cannot include website links.' };
  }
  if (/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(comment)) {
    return { value: '', error: 'Comments cannot include email addresses.' };
  }
  const compactDigits = comment.replace(/\D/g, '');
  if (compactDigits.length >= 7) {
    return { value: '', error: 'Comments cannot include telephone numbers.' };
  }
  return { value: comment, error: '' };
}

export function getCookie(request: Request, name: string): string {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function secureCookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  return [
    `${name}=${value}`,
    'Path=/',
    'Secure',
    'SameSite=Lax',
    httpOnly ? 'HttpOnly' : '',
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join('; ');
}

export function reviewerSessionCookies(token: string, csrf: string): string[] {
  return [
    secureCookie(FEEDBACK_SESSION_COOKIE, token, SESSION_SECONDS, true),
    secureCookie(FEEDBACK_CSRF_COOKIE, csrf, SESSION_SECONDS, false),
  ];
}

export function clearReviewerSessionCookies(): string[] {
  return [
    secureCookie(FEEDBACK_SESSION_COOKIE, '', 0, true),
    secureCookie(FEEDBACK_CSRF_COOKIE, '', 0, false),
  ];
}

export function oauthCookies(values: {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}): string[] {
  return [
    secureCookie(FEEDBACK_OAUTH_STATE_COOKIE, values.state, OAUTH_SECONDS, true),
    secureCookie(FEEDBACK_OAUTH_NONCE_COOKIE, values.nonce, OAUTH_SECONDS, true),
    secureCookie(FEEDBACK_OAUTH_PKCE_COOKIE, values.verifier, OAUTH_SECONDS, true),
    secureCookie(FEEDBACK_OAUTH_RETURN_COOKIE, values.returnTo, OAUTH_SECONDS, true),
  ];
}

export function clearOauthCookies(): string[] {
  return [
    secureCookie(FEEDBACK_OAUTH_STATE_COOKIE, '', 0, true),
    secureCookie(FEEDBACK_OAUTH_NONCE_COOKIE, '', 0, true),
    secureCookie(FEEDBACK_OAUTH_PKCE_COOKIE, '', 0, true),
    secureCookie(FEEDBACK_OAUTH_RETURN_COOKIE, '', 0, true),
  ];
}

export function appendSetCookies(response: Response, cookies: string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function safeFeedbackReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return '/properties';
  }
  try {
    const parsed = new URL(value, 'https://primeprop.invalid');
    if (!SAFE_RETURN_PATHS.has(parsed.pathname)) return '/properties';
    const allowedKeys = parsed.pathname === '/agent-profile'
      ? new Set(['id', 'listing'])
      : parsed.pathname.startsWith('/listing-detail')
        ? new Set(['id'])
        : new Set<string>();
    for (const key of parsed.searchParams.keys()) {
      if (!allowedKeys.has(key)) return '/properties';
      const parameter = parsed.searchParams.get(key) || '';
      if (!/^\d+$/.test(parameter) || Number(parameter) <= 0) return '/properties';
    }
    if (parsed.pathname === '/agent-profile' && !parsed.searchParams.has('id') && !parsed.searchParams.has('listing')) {
      return '/properties';
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/properties';
  }
}

export function returnPathWithFeedbackStatus(returnTo: string, status: string): string {
  const safe = safeFeedbackReturnPath(returnTo);
  const parsed = new URL(safe, 'https://primeprop.invalid');
  parsed.searchParams.set('feedbackAuth', status);
  return `${parsed.pathname}${parsed.search}`;
}

export function isAllowedFeedbackOrigin(origin: string | null, env: FeedbackBindings): boolean {
  if (!origin) return false;
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  return env.ENVIRONMENT === 'test' && origin === 'https://primeprop.test';
}

export function feedbackWriteRequestError(request: Request, env: FeedbackBindings): string {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return 'Content-Type must be application/json.';
  }
  if (!isAllowedFeedbackOrigin(request.headers.get('Origin'), env)) {
    return 'Invalid request origin.';
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') return 'Cross-site request rejected.';
  return '';
}

export async function professionalConflict(
  db: D1Database,
  googleSub: string,
  email: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM users
     WHERE google_id = ? OR lower(email) = ?
     LIMIT 1`,
  ).bind(googleSub, normalizeEmail(email)).first();
  return !!row;
}

export async function reviewerEmailConflict(
  db: D1Database,
  reviewerId: number | null,
  emailHash: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM reviewer_identities
     WHERE email_hash = ? AND (? IS NULL OR id <> ?)
     LIMIT 1`,
  ).bind(emailHash, reviewerId, reviewerId).first();
  return !!row;
}

export async function isReviewerBanned(
  db: D1Database,
  reviewerId: number,
  googleSub: string,
  emailHash: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id FROM reviewer_bans
     WHERE active = 1
       AND (
         reviewer_id = ?
         OR (google_sub IS NOT NULL AND google_sub = ?)
         OR (email_hash IS NOT NULL AND email_hash = ?)
       )
     LIMIT 1`,
  ).bind(reviewerId, googleSub, emailHash).first();
  return !!row;
}

export async function findReviewerSession(
  request: Request,
  env: FeedbackBindings,
): Promise<ReviewerSession | null> {
  const token = getCookie(request, FEEDBACK_SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT session.id AS session_id,
            session.reviewer_id,
            session.csrf_hash,
            session.expires_at,
            reviewer.google_sub,
            reviewer.email_normalized,
            reviewer.email_hash
     FROM reviewer_sessions session
     JOIN reviewer_identities reviewer ON reviewer.id = session.reviewer_id
     WHERE session.token_hash = ?
       AND session.revoked = 0
       AND session.expires_at > ?
     LIMIT 1`,
  ).bind(tokenHash, Date.now()).first<{
    session_id: number;
    reviewer_id: number;
    csrf_hash: string;
    expires_at: number;
    google_sub: string;
    email_normalized: string;
    email_hash: string;
  }>();
  if (!row) return null;
  const [banned, conflict] = await Promise.all([
    isReviewerBanned(env.DB, row.reviewer_id, row.google_sub, row.email_hash),
    professionalConflict(env.DB, row.google_sub, row.email_normalized),
  ]);
  return {
    sessionId: row.session_id,
    reviewerId: row.reviewer_id,
    googleSub: row.google_sub,
    email: row.email_normalized,
    emailHash: row.email_hash,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at,
    banned,
    professionalConflict: conflict,
  };
}

export async function issueReviewerSession(
  env: FeedbackBindings,
  reviewerId: number,
): Promise<{ token: string; csrf: string; expiresAt: number }> {
  const token = randomBase64Url(48);
  const csrf = randomBase64Url(32);
  const tokenHash = await sha256Hex(token);
  const csrfHash = await sha256Hex(csrf);
  const expiresAt = Date.now() + SESSION_SECONDS * 1000;
  await env.DB.prepare(
    `INSERT INTO reviewer_sessions
     (reviewer_id, token_hash, csrf_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(reviewerId, tokenHash, csrfHash, expiresAt).run();
  return { token, csrf, expiresAt };
}

export async function revokeReviewerSession(request: Request, env: FeedbackBindings): Promise<void> {
  const token = getCookie(request, FEEDBACK_SESSION_COOKIE);
  if (!token) return;
  await env.DB.prepare('UPDATE reviewer_sessions SET revoked = 1 WHERE token_hash = ?')
    .bind(await sha256Hex(token)).run();
}

export async function validateReviewerCsrf(
  request: Request,
  session: ReviewerSession,
): Promise<boolean> {
  const cookieToken = getCookie(request, FEEDBACK_CSRF_COOKIE);
  const headerToken = request.headers.get('X-CSRF-Token') || '';
  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) return false;
  const suppliedHash = await sha256Hex(headerToken);
  return timingSafeEqual(suppliedHash, session.csrfHash);
}

export async function enforceFeedbackRateLimit(
  env: FeedbackBindings,
  key: string,
  limit: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  const id = env.RATE_LIMITER.idFromName(key);
  const result = await env.RATE_LIMITER.get(id).checkLimit(key, limit);
  return {
    allowed: Boolean(result.allowed),
    retryAfter: Number(result.retryAfter || 60),
  };
}
