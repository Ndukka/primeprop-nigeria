import { jwtVerify } from 'jose';
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

const encoder = new TextEncoder();
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

  try {
    const verified = await jwtVerify(accessToken, encoder.encode(env.JWT_SECRET), {
      issuer: 'primeprop',
    });
    const userId = Number(verified.payload.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return response;

    const user = await env.DB.prepare(
      'SELECT account_status FROM users WHERE id = ?'
    ).bind(userId).first<{ account_status: string }>();

    if (user?.account_status !== 'pending') return response;

    const headers = new Headers(response.headers);
    headers.set('Location', '/login.html?status=pending');
    headers.append('Set-Cookie', 'pp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    headers.append('Set-Cookie', 'pp_refresh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    headers.append('Set-Cookie', 'pp_csrf=; Path=/; Secure; SameSite=Lax; Max-Age=0');
    return new Response(null, { status: 302, headers });
  } catch {
    return response;
  }
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

    let response = await worker.fetch(request, env, ctx);

    if (url.pathname === '/auth/google/callback') {
      response = await enforcePendingOAuthResponse(response, env);
    }

    return hardenMutatedHtml(response);
  },
};

export { RateLimiter };
