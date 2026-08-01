import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  R2Bucket,
} from '@cloudflare/workers-types';
import worker, { RateLimiter } from './index';

type Bindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
  RESEND_API_KEY?: string;
  PASSWORD_RESET_FROM?: string;
  PUBLIC_APP_URL?: string;
};

type AuthPayload = JWTPayload & {
  id: number;
  email: string;
  role: string;
  name: string;
  token_use: 'access' | 'refresh';
  jti: string;
};

type ActiveUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  account_status: string;
  security_stamp_changed_at: number;
};

type PreparedRequest = {
  request: Request;
  setCookies: string[];
};

const encoder = new TextEncoder();
const ACCESS_SECONDS = 15 * 60;
const REFRESH_SECONDS = 7 * 24 * 60 * 60;
const COOKIE_OPTS = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const CSRF_COOKIE_OPTS = 'Path=/; Secure; SameSite=Lax';

const GENERIC_RESET_RESPONSE = {
  success: true,
  message: 'If the email exists, a reset link has been sent.',
};

const PUBLIC_AUTH_WRITE_PATHS = new Set([
  '/auth/login',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/reset-password',
]);

const PRODUCTION_ORIGINS = new Set([
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

function getCookie(request: Request, name: string): string {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function isStateChanging(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method.toUpperCase());
}

function isAllowedOrigin(origin: string, env: Bindings): boolean {
  if (PRODUCTION_ORIGINS.has(origin)) return true;
  return env.ENVIRONMENT === 'test' && origin === 'https://primeprop.test';
}

function requiresBrowserOriginCheck(request: Request, path: string): boolean {
  if (!isStateChanging(request.method)) return false;
  if (PUBLIC_AUTH_WRITE_PATHS.has(path)) return false;

  const cookie = request.headers.get('Cookie') || '';
  return cookie.includes('pp_session=') || cookie.includes('pp_refresh=');
}

function requiresAuthenticationPreflight(path: string, method: string): boolean {
  if (path === '/auth/session' || path === '/auth/logout' || path === '/auth/profile') return true;
  if (path === '/auth/register' || path === '/auth/my-listings') return true;
  if (path.startsWith('/auth/users')) return true;
  if (path.startsWith('/api/uploads')) return true;
  if (path === '/api/images/upload') return true;
  if (path.startsWith('/api/') && isStateChanging(method)) return true;
  return false;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase().slice(0, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function configuredResetBaseUrl(env: Bindings): URL | null {
  if (!env.PUBLIC_APP_URL) return null;

  try {
    const url = new URL(env.PUBLIC_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function authCookies(accessToken: string, refreshToken: string, csrfToken: string): string[] {
  return [
    `pp_session=${accessToken}; ${COOKIE_OPTS}; Max-Age=${ACCESS_SECONDS}`,
    `pp_refresh=${refreshToken}; ${COOKIE_OPTS}; Max-Age=${REFRESH_SECONDS}`,
    `pp_csrf=${csrfToken}; ${CSRF_COOKIE_OPTS}; Max-Age=${REFRESH_SECONDS}`,
  ];
}

function clearedAuthCookies(): string[] {
  return [
    `pp_session=; ${COOKIE_OPTS}; Max-Age=0`,
    `pp_refresh=; ${COOKIE_OPTS}; Max-Age=0`,
    `pp_csrf=; ${CSRF_COOKIE_OPTS}; Max-Age=0`,
  ];
}

function appendSetCookies(response: Response, cookies: string[]): Response {
  if (cookies.length === 0) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function unauthorized(message = 'Authentication required. Please log in again.'): Response {
  return appendSetCookies(
    jsonResponse({ success: false, message }, 401),
    clearedAuthCookies(),
  );
}

function replaceAuthenticationCookies(request: Request, access: string, refresh: string, csrf: string): Request {
  const headers = new Headers(request.headers);
  const retained = (headers.get('Cookie') || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^(pp_session|pp_refresh|pp_csrf)=/.test(part));

  retained.push(`pp_session=${access}`, `pp_refresh=${refresh}`, `pp_csrf=${csrf}`);
  headers.set('Cookie', retained.join('; '));
  return new Request(request, { headers });
}

async function createJwt(
  user: ActiveUser,
  secret: string,
  tokenUse: 'access' | 'refresh',
  seconds: number,
): Promise<{ token: string; jti: string }> {
  const jti = crypto.randomUUID();
  const token = await new SignJWT({
    id: user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    token_use: tokenUse,
    jti,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${seconds}s`)
    .setIssuer('primeprop')
    .sign(encoder.encode(secret));

  return { token, jti };
}

async function verifyJwt(token: string, env: Bindings, expectedUse: 'access' | 'refresh'): Promise<AuthPayload | null> {
  try {
    const verified = await jwtVerify(token, encoder.encode(env.JWT_SECRET), {
      issuer: 'primeprop',
      clockTolerance: 30,
    });
    const payload = verified.payload as AuthPayload;
    if (payload.token_use !== expectedUse) return null;
    if (!Number.isSafeInteger(payload.id) || payload.id <= 0) return null;
    if (!payload.iat || !payload.jti) return null;
    return payload;
  } catch {
    return null;
  }
}

async function getActiveUser(env: Bindings, userId: number): Promise<ActiveUser | null> {
  const user = await env.DB.prepare(
    `SELECT id, email, name, role, account_status,
            COALESCE(security_stamp_changed_at, 0) AS security_stamp_changed_at
     FROM users
     WHERE id = ?`
  ).bind(userId).first<ActiveUser>();

  if (!user || user.account_status !== 'active') return null;
  return user;
}

function issuedBeforeInvalidation(payload: AuthPayload, user: ActiveUser): boolean {
  return (payload.iat || 0) * 1000 < Number(user.security_stamp_changed_at || 0);
}

async function validateAccessToken(token: string, env: Bindings): Promise<boolean> {
  const payload = await verifyJwt(token, env, 'access');
  if (!payload) return false;
  const user = await getActiveUser(env, payload.id);
  return !!user && !issuedBeforeInvalidation(payload, user);
}

async function rotateRefreshToken(request: Request, refreshToken: string, env: Bindings): Promise<PreparedRequest | Response> {
  const payload = await verifyJwt(refreshToken, env, 'refresh');
  if (!payload) return unauthorized();

  const tokenHash = await sha256Hex(refreshToken);
  const session = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.token_family, s.revoked, s.expires_at,
            u.email, u.name, u.role, u.account_status,
            COALESCE(u.security_stamp_changed_at, 0) AS security_stamp_changed_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).bind(tokenHash).first<{
    id: number;
    user_id: number;
    token_family: string;
    revoked: number;
    expires_at: number;
    email: string;
    name: string;
    role: string;
    account_status: string;
    security_stamp_changed_at: number;
  }>();

  if (!session) return unauthorized();

  if (session.revoked === 1) {
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE token_family = ?').bind(session.token_family),
      env.DB.prepare('UPDATE users SET security_stamp = ? WHERE id = ?').bind(crypto.randomUUID(), session.user_id),
    ]);
    return unauthorized('Session reuse was detected. Please sign in again.');
  }

  const user: ActiveUser = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role,
    account_status: session.account_status,
    security_stamp_changed_at: Number(session.security_stamp_changed_at || 0),
  };

  if (
    session.expires_at <= Date.now()
    || user.account_status !== 'active'
    || issuedBeforeInvalidation(payload, user)
  ) {
    await env.DB.prepare('UPDATE sessions SET revoked = 1 WHERE token_family = ?')
      .bind(session.token_family).run();
    return unauthorized();
  }

  const access = await createJwt(user, env.JWT_SECRET, 'access', ACCESS_SECONDS);
  const refresh = await createJwt(user, env.JWT_SECRET, 'refresh', REFRESH_SECONDS);
  const newHash = await sha256Hex(refresh.token);
  const expiresAt = Date.now() + REFRESH_SECONDS * 1000;
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  const userAgent = (request.headers.get('User-Agent') || '').slice(0, 500);

  await env.DB.batch([
    env.DB.prepare('UPDATE sessions SET revoked = 1, rotated_at = datetime(\'now\') WHERE id = ?')
      .bind(session.id),
    env.DB.prepare(
      `INSERT INTO sessions
       (user_id, token_hash, token_family, token_jti, user_agent, ip_address, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(user.id, newHash, session.token_family, refresh.jti, userAgent, ip, expiresAt),
  ]);

  const csrf = randomToken();
  return {
    request: replaceAuthenticationCookies(request, access.token, refresh.token, csrf),
    setCookies: authCookies(access.token, refresh.token, csrf),
  };
}

async function prepareAuthenticatedRequest(request: Request, env: Bindings, path: string): Promise<PreparedRequest | Response> {
  if (!requiresAuthenticationPreflight(path, request.method)) {
    return { request, setCookies: [] };
  }

  const cookieAccess = getCookie(request, 'pp_session');
  const authorization = request.headers.get('Authorization') || '';
  const bearerAccess = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const accessToken = cookieAccess || bearerAccess;

  if (accessToken && await validateAccessToken(accessToken, env)) {
    return { request, setCookies: [] };
  }

  // A bearer-only client must provide a valid access token. It cannot silently
  // refresh because refresh tokens are cookie-bound browser credentials.
  if (bearerAccess) return unauthorized();

  const refreshToken = getCookie(request, 'pp_refresh');
  if (!refreshToken) return unauthorized();

  return rotateRefreshToken(request, refreshToken, env);
}

async function checkForgotPasswordRateLimit(request: Request, env: Bindings): Promise<Response | null> {
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')
    || 'unknown';
  const id = env.RATE_LIMITER.idFromName(`auth:forgot-password:${ip}`);
  const result = await env.RATE_LIMITER.get(id).checkLimit(`auth:forgot-password:${ip}`, 3);

  if (result.allowed) return null;

  const response = jsonResponse({
    success: false,
    message: 'Too many requests. Please try again later.',
  }, 429);
  response.headers.set('Retry-After', String(result.retryAfter || 60));
  return response;
}

async function sendResetEmail(
  env: Bindings,
  recipient: string,
  resetUrl: string,
): Promise<boolean> {
  if (!env.RESEND_API_KEY || !env.PASSWORD_RESET_FROM) return false;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.PASSWORD_RESET_FROM,
      to: [recipient],
      subject: 'Reset your PrimeProp Nigeria password',
      html: [
        '<p>A password reset was requested for your PrimeProp Nigeria account.</p>',
        `<p><a href="${resetUrl}">Reset your password</a></p>`,
        '<p>This link expires in 15 minutes and can be used once.</p>',
        '<p>If you did not request this, you can ignore this message.</p>',
      ].join(''),
    }),
  });

  return response.ok;
}

async function handleForgotPassword(request: Request, env: Bindings): Promise<Response> {
  const limited = await checkForgotPasswordRateLimit(request, env);
  if (limited) return limited;

  const appUrl = configuredResetBaseUrl(env);
  if (!env.RESEND_API_KEY || !env.PASSWORD_RESET_FROM || !appUrl) {
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'password_reset_email_not_configured',
      message: 'Configure RESEND_API_KEY, PASSWORD_RESET_FROM, and PUBLIC_APP_URL.',
    }));
    return jsonResponse({
      success: false,
      message: 'Password recovery is temporarily unavailable.',
    }, 503);
  }

  const body = await request.json().catch(() => null) as { email?: unknown } | null;
  const email = normalizeEmail(body?.email);
  if (!email) return jsonResponse(GENERIC_RESET_RESPONSE, 202);

  const user = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? AND password_hash IS NOT NULL AND account_status = ?'
  ).bind(email, 'active').first<{ id: number }>();

  if (!user) return jsonResponse(GENERIC_RESET_RESPONSE, 202);

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const expiresAt = Date.now() + 15 * 60 * 1000;

  await env.DB.batch([
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(user.id),
    env.DB.prepare(
      'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).bind(user.id, tokenHash, expiresAt),
  ]);

  const resetUrl = new URL('/reset-password.html', appUrl);
  resetUrl.searchParams.set('token', token);

  const sent = await sendResetEmail(env, email, resetUrl.toString()).catch(() => false);
  if (!sent) {
    await env.DB.prepare('DELETE FROM password_resets WHERE token = ?').bind(tokenHash).run();
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'password_reset_email_failed',
      user_id: user.id,
    }));
  }

  // Never return or log the token, and do not reveal delivery or account state.
  return jsonResponse(GENERIC_RESET_RESPONSE, 202);
}

function extractSetCookieValue(headers: Headers, name: string): string {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof compatible.getSetCookie === 'function'
    ? compatible.getSetCookie()
    : [headers.get('Set-Cookie') || ''];

  for (const value of values) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));
    if (match) return match[1];
  }
  return '';
}

async function enforcePendingOAuthResponse(response: Response, env: Bindings): Promise<Response> {
  if (response.status < 300 || response.status >= 400) return response;

  const accessToken = extractSetCookieValue(response.headers, 'pp_session');
  if (!accessToken) return response;

  const payload = await verifyJwt(accessToken, env, 'access');
  if (!payload) return response;

  const user = await env.DB.prepare(
    'SELECT account_status FROM users WHERE id = ?'
  ).bind(payload.id).first<{ account_status: string }>();

  if (user?.account_status !== 'pending') return response;

  const headers = new Headers(response.headers);
  headers.set('Location', '/login.html?status=pending');
  for (const cookie of clearedAuthCookies()) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

function hardenMutatedHtml(response: Response): Response {
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) return response;

  const headers = new Headers(response.headers);
  // The inner Worker rewrites HTML to inject fresh nonces. Validators and body
  // length from the original static asset are no longer valid after mutation.
  headers.delete('Content-Length');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.set('Cache-Control', 'private, no-store, max-age=0');
  headers.set('Pragma', 'no-cache');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (requiresBrowserOriginCheck(request, url.pathname)) {
      const origin = request.headers.get('Origin');
      if (!origin || !isAllowedOrigin(origin, env)) {
        return jsonResponse({ success: false, message: 'Invalid origin' }, 403);
      }
    }

    if (url.pathname === '/auth/forgot-password' && request.method === 'POST') {
      return handleForgotPassword(request, env);
    }

    const prepared = await prepareAuthenticatedRequest(request, env, url.pathname);
    if (prepared instanceof Response) return prepared;

    let response = await worker.fetch(prepared.request, env, ctx);

    if (url.pathname === '/auth/google/callback') {
      response = await enforcePendingOAuthResponse(response, env);
    }

    response = hardenMutatedHtml(response);
    return appendSetCookies(response, prepared.setCookies);
  },
};

export { RateLimiter };
