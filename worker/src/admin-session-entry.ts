import { jwtVerify } from 'jose';
import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  R2Bucket,
} from '@cloudflare/workers-types';
import productionWorker, { RateLimiter } from './production-entry';

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
  GOOGLE_REDIRECT_URI?: string;
};

type SessionUser = {
  role?: string;
};

type SessionBody = {
  success?: boolean;
  data?: {
    user?: SessionUser;
  };
};

const encoder = new TextEncoder();
const ADMIN_ROUTE_PREFIXES = [
  '/auth/admin-',
  '/auth/feedback/admin/',
  '/auth/security/',
];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

function jsonResponse(body: unknown, status: number): Response {
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

function isAdministratorRoute(path: string): boolean {
  return ADMIN_ROUTE_PREFIXES.some(prefix => path.startsWith(prefix));
}

function getCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function setCookieValues(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatible.getSetCookie === 'function') {
    return compatible.getSetCookie();
  }

  const combined = headers.get('Set-Cookie');
  return combined
    ? combined.split(/,(?=\s*pp_(?:session|refresh|csrf)=)/i).map(value => value.trim())
    : [];
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

function cookiePairs(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    cookies.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return cookies;
}

function refreshedRequest(request: Request, setCookies: string[]): Request {
  const cookies = cookiePairs(request.headers.get('Cookie') || '');
  let refreshedCsrf = '';

  for (const setCookie of setCookies) {
    const pair = setCookie.split(';', 1)[0] || '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    const cleared = value === '' || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(setCookie);
    if (cleared) cookies.delete(name);
    else cookies.set(name, value);
    if (name === 'pp_csrf' && !cleared) refreshedCsrf = decodeURIComponent(value);
  }

  const headers = new Headers(request.headers);
  const nextCookieHeader = [...cookies.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
  if (nextCookieHeader) headers.set('Cookie', nextCookieHeader);
  else headers.delete('Cookie');

  if (!SAFE_METHODS.has(request.method.toUpperCase()) && refreshedCsrf) {
    headers.set('X-CSRF-Token', refreshedCsrf);
  }

  return new Request(request, { headers });
}

function sessionRequest(request: Request): Request {
  const url = new URL('/auth/session', request.url);
  const headers = new Headers(request.headers);
  headers.delete('Content-Length');
  headers.delete('Content-Type');
  headers.delete('X-CSRF-Token');
  return new Request(url.toString(), {
    method: 'GET',
    headers,
  });
}

async function hasCurrentAdministratorAccess(request: Request, env: Bindings): Promise<boolean> {
  const cookieAccess = getCookie(request, 'pp_session');
  const authorization = request.headers.get('Authorization') || '';
  const bearerAccess = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const token = cookieAccess || bearerAccess;
  if (!token) return false;

  try {
    const verified = await jwtVerify(token, encoder.encode(env.JWT_SECRET), {
      issuer: 'primeprop',
      clockTolerance: 30,
    });
    const payload = verified.payload as {
      id?: number;
      token_use?: string;
      iat?: number;
    };
    if (
      payload.token_use !== 'access'
      || !Number.isSafeInteger(payload.id)
      || !payload.id
      || !payload.iat
    ) return false;

    const user = await env.DB.prepare(
      `SELECT role, account_status,
              COALESCE(security_stamp_changed_at, 0) AS security_stamp_changed_at
       FROM users
       WHERE id = ?`,
    ).bind(payload.id).first<{
      role: string;
      account_status: string;
      security_stamp_changed_at: number;
    }>();

    return !!user
      && user.role === 'admin'
      && user.account_status === 'active'
      && payload.iat * 1000 >= Number(user.security_stamp_changed_at || 0);
  } catch {
    return false;
  }
}

async function resolveAdministratorSession(
  request: Request,
  env: Bindings,
  ctx: ExecutionContext,
): Promise<Response> {
  if (await hasCurrentAdministratorAccess(request, env)) {
    return productionWorker.fetch(request, env, ctx);
  }

  const sessionResponse = await productionWorker.fetch(sessionRequest(request), env, ctx);
  const cookies = setCookieValues(sessionResponse.headers);
  const body = await sessionResponse.clone().json().catch(() => null) as SessionBody | null;

  if (!sessionResponse.ok || !body?.success || !body.data?.user) {
    return sessionResponse;
  }

  if (body.data.user.role !== 'admin') {
    return appendSetCookies(
      jsonResponse({
        success: false,
        message: 'Insufficient permissions. This action requires: admin',
      }, 403),
      cookies,
    );
  }

  const response = await productionWorker.fetch(refreshedRequest(request, cookies), env, ctx);
  return appendSetCookies(response, cookies);
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!isAdministratorRoute(path)) {
      return productionWorker.fetch(request, env, ctx);
    }
    return resolveAdministratorSession(request, env, ctx);
  },
};

export { RateLimiter };
