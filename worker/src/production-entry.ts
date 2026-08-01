import { jwtVerify } from 'jose';
import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  R2Bucket,
} from '@cloudflare/workers-types';
import hardenedWorker, { RateLimiter } from './hardened-entry';
import { auditStorage } from './storage-audit';

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

const encoder = new TextEncoder();
const ALLOWED_APPLICATION_ORIGINS = new Set([
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
]);
const CLEAN_PAGE_PATHS = new Set([
  '/',
  '/properties',
  '/properties-rent',
  '/properties-sale',
  '/properties-land',
  '/areas',
  '/listing-detail',
  '/listing-detail-1',
  '/listing-detail-2',
  '/listing-detail-3',
  '/login',
  '/admin',
  '/agent',
  '/reset-password',
]);

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

function normalizeApplicationPath(request: Request): Request {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/auth/') && !url.pathname.startsWith('/api/')) {
    return request;
  }

  const normalized = url.pathname.length > 1
    ? url.pathname.replace(/\/+$/, '')
    : url.pathname;

  if (normalized === url.pathname) return request;
  url.pathname = normalized;
  return new Request(url.toString(), request);
}

function canonicalPageRedirect(request: Request): Response | null {
  if (!['GET', 'HEAD'].includes(request.method)) return null;
  const url = new URL(request.url);
  let canonical = url.pathname;

  if (canonical === '/index.html' || canonical === '/index/') {
    canonical = '/';
  } else if (canonical.endsWith('.html')) {
    canonical = canonical.slice(0, -5) || '/';
  } else if (canonical.length > 1 && canonical.endsWith('/')) {
    canonical = canonical.replace(/\/+$/, '');
  }

  if (canonical === url.pathname || !CLEAN_PAGE_PATHS.has(canonical)) return null;
  const location = `${canonical}${url.search}`;
  return new Response(null, {
    status: 307,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function withAssetCachePolicy(path: string, response: Response): Response {
  if (!response.ok) return response;
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('text/html')) return response;

  const headers = new Headers(response.headers);
  const isHashedAsset = /^\/assets\/.+\.[a-f0-9]{12}\.(?:css|js)$/i.test(path);
  const isStableAlias = /^\/(?:styles|home)\.css$/i.test(path)
    || /^\/js\/(?:app|strict-runtime)\.js$/i.test(path);

  if (isHashedAsset) {
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (isStableAlias) {
    headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
  }

  headers.set('Vary', 'Accept-Encoding');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isValidGoogleRedirectUri(value: string | undefined, env: Bindings): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);
    const testOriginAllowed = env.ENVIRONMENT === 'test'
      && url.origin === 'https://primeprop.test';

    return url.protocol === 'https:'
      && (ALLOWED_APPLICATION_ORIGINS.has(url.origin) || testOriginAllowed)
      && url.pathname === '/auth/google/callback'
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === '';
  } catch {
    return false;
  }
}

async function sanitizeOAuthError(response: Response): Promise<Response> {
  if (response.status < 400) return response;
  const contentType = response.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) return response;

  const body = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'details')) return response;

  delete body.details;
  const headers = new Headers(response.headers);
  headers.delete('Content-Length');
  headers.set('Cache-Control', 'no-store');

  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function getCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

async function isActiveAdministrator(request: Request, env: Bindings): Promise<boolean> {
  const authorization = request.headers.get('Authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const token = bearer || getCookie(request, 'pp_session');
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
       WHERE id = ?`
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

async function handleStorageAudit(request: Request, env: Bindings): Promise<Response> {
  if (request.method !== 'GET') {
    const response = jsonResponse({ success: false, message: 'Method not allowed' }, 405);
    response.headers.set('Allow', 'GET');
    return response;
  }
  if (!await isActiveAdministrator(request, env)) {
    return jsonResponse({ success: false, message: 'Administrator authentication required' }, 401);
  }

  try {
    const report = await auditStorage(env);
    return jsonResponse({ success: true, data: report }, 200);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      event: 'storage_integrity_audit_failed',
      message: error instanceof Error ? error.message : 'Unknown audit error',
    }));
    return jsonResponse({ success: false, message: 'Storage audit could not be completed' }, 500);
  }
}

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    request = normalizeApplicationPath(request);
    const canonicalRedirect = canonicalPageRedirect(request);
    if (canonicalRedirect) return canonicalRedirect;

    const path = new URL(request.url).pathname;

    if (path === '/auth/security/storage-audit') {
      return handleStorageAudit(request, env);
    }

    if (
      (path === '/auth/google' || path === '/auth/google/callback')
      && !isValidGoogleRedirectUri(env.GOOGLE_REDIRECT_URI, env)
    ) {
      return jsonResponse({
        success: false,
        message: 'Google authentication is not configured correctly.',
      }, 503);
    }

    let response = await hardenedWorker.fetch(request, env, ctx);
    if (path === '/auth/google/callback') {
      response = await sanitizeOAuthError(response);
    }
    return withAssetCachePolicy(path, response);
  },
};

export { RateLimiter };
