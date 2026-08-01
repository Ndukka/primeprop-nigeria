import type {
  D1Database,
  DurableObjectNamespace,
  Fetcher,
  R2Bucket,
} from '@cloudflare/workers-types';
import hardenedWorker, { RateLimiter } from './hardened-entry';

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

const ALLOWED_APPLICATION_ORIGINS = new Set([
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
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

export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    request = normalizeApplicationPath(request);
    const path = new URL(request.url).pathname;

    if (
      (path === '/auth/google' || path === '/auth/google/callback')
      && !isValidGoogleRedirectUri(env.GOOGLE_REDIRECT_URI, env)
    ) {
      return jsonResponse({
        success: false,
        message: 'Google authentication is not configured correctly.',
      }, 503);
    }

    const response = await hardenedWorker.fetch(request, env, ctx);
    if (path === '/auth/google/callback') {
      return sanitizeOAuthError(response);
    }
    return response;
  },
};

export { RateLimiter };
