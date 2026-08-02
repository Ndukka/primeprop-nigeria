import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const ADMIN_EMAIL = 'test-admin@primeprop.invalid';
const ADMIN_PASSWORD = 'TestAdmin123!';

type CookieJar = Map<string, string>;

function getSetCookieValues(headers: Headers): string[] {
  const compatibleHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatibleHeaders.getSetCookie === 'function') return compatibleHeaders.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined
    ? combined.split(/,(?=\s*(?:__Host-)?pp_[^=]+=)/i).map(value => value.trim())
    : [];
}

function applySetCookies(jar: CookieJar, headers: Headers): string[] {
  const values = getSetCookieValues(headers);
  for (const setCookie of values) {
    const pair = setCookie.split(';', 1)[0] || '';
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    const cleared = value === '' || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(setCookie);
    if (cleared) jar.delete(name);
    else jar.set(name, value);
  }
  return values;
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function workerFetch(path: string, jar: CookieJar, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const cookies = cookieHeader(jar);
  if (cookies) headers.set('Cookie', cookies);
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'PrimeProp session lifecycle test');
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', '203.0.113.44');
  return exports.default.fetch(new Request(`${BASE}${path}`, { ...init, headers }));
}

async function login(): Promise<CookieJar> {
  const jar: CookieJar = new Map();
  const response = await workerFetch('/auth/login', jar, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  expect(response.status).toBe(200);
  applySetCookies(jar, response.headers);
  expect(jar.get('pp_session')).toBeTruthy();
  expect(jar.get('pp_refresh')).toBeTruthy();
  expect(jar.get('pp_csrf')).toBeTruthy();
  return jar;
}

function expireAccess(jar: CookieJar): void {
  jar.delete('pp_session');
}

function assertNoRefreshClear(values: string[]): void {
  const joined = values.join('\n');
  expect(joined).not.toContain('pp_refresh=;');
  expect(joined).not.toContain('pp_csrf=;');
}

describe('full professional session expiry lifecycle', () => {
  it('survives repeated access-expiry and refresh rotations', async () => {
    const jar = await login();

    for (let cycle = 0; cycle < 4; cycle += 1) {
      expireAccess(jar);
      const beforeRefresh = jar.get('pp_refresh');
      const response = await workerFetch('/auth/admin-districts', jar);
      const values = applySetCookies(jar, response.headers);

      expect(response.status, `cycle ${cycle + 1}`).toBe(200);
      expect(jar.get('pp_session'), `cycle ${cycle + 1} access`).toBeTruthy();
      expect(jar.get('pp_refresh'), `cycle ${cycle + 1} refresh`).toBeTruthy();
      expect(jar.get('pp_refresh'), `cycle ${cycle + 1} rotation`).not.toBe(beforeRefresh);
      expect(jar.get('pp_csrf'), `cycle ${cycle + 1} csrf`).toBeTruthy();
      assertNoRefreshClear(values);
    }
  });

  it('survives a direct session check racing a protected dashboard read', async () => {
    const jar = await login();
    expireAccess(jar);
    const startingCookie = cookieHeader(jar);

    const [sessionResponse, dashboardResponse] = await Promise.all([
      exports.default.fetch(new Request(`${BASE}/auth/session`, {
        headers: {
          Cookie: startingCookie,
          'User-Agent': 'PrimeProp session lifecycle test',
          'CF-Connecting-IP': '203.0.113.44',
        },
      })),
      exports.default.fetch(new Request(`${BASE}/auth/admin-listings?limit=10`, {
        headers: {
          Cookie: startingCookie,
          'User-Agent': 'PrimeProp session lifecycle test',
          'CF-Connecting-IP': '203.0.113.44',
        },
      })),
    ]);

    expect(sessionResponse.status).toBe(200);
    expect(dashboardResponse.status).toBe(200);
    const sessionCookies = getSetCookieValues(sessionResponse.headers);
    const dashboardCookies = getSetCookieValues(dashboardResponse.headers);
    assertNoRefreshClear(sessionCookies);
    assertNoRefreshClear(dashboardCookies);
    expect([...sessionCookies, ...dashboardCookies].some(value => value.startsWith('pp_refresh='))).toBe(true);
  });

  it('refreshes every protected administrator read family after access expiry', async () => {
    const paths = [
      '/auth/admin-listings?limit=10',
      '/auth/admin-districts',
      '/auth/admin-users',
      '/auth/users',
      '/auth/feedback/admin/overview',
      '/auth/feedback/admin/ratings?limit=10',
      '/auth/feedback/admin/reports?limit=10',
      '/auth/feedback/admin/reviewers',
      '/auth/security/storage-audit',
      '/api/uploads?limit=10',
    ];

    for (const path of paths) {
      const jar = await login();
      expireAccess(jar);
      const response = await workerFetch(path, jar);
      const values = applySetCookies(jar, response.headers);
      expect(response.status, path).toBe(200);
      expect(jar.get('pp_session'), `${path} access`).toBeTruthy();
      expect(jar.get('pp_refresh'), `${path} refresh`).toBeTruthy();
      assertNoRefreshClear(values);
    }
  });
});
