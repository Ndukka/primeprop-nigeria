import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const ADMIN_EMAIL = 'test-admin@primeprop.invalid';
const ADMIN_PASSWORD = 'TestAdmin123!';
const AGENT_EMAIL = 'test-agent@primeprop.invalid';
const AGENT_PASSWORD = 'TestAgent123!';

type TestEnv = {
  DB: D1Database;
};

type LoginResult = {
  response: Response;
  setCookies: string[];
  refreshToken: string;
  csrfToken: string;
};

const testEnv = env as unknown as TestEnv;

function getSetCookieValues(headers: Headers): string[] {
  const compatibleHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatibleHeaders.getSetCookie === 'function') {
    return compatibleHeaders.getSetCookie();
  }

  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookieValue(setCookies: string[], name: string): string {
  for (const value of setCookies) {
    const match = value.match(new RegExp(`(?:^|,\\s*)${name}=([^;,]+)`));
    if (match) return match[1];
  }
  return '';
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map(value => value.split(';', 1)[0]).join('; ');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function login(email: string, password: string): Promise<LoginResult> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const setCookies = getSetCookieValues(response.headers);

  return {
    response,
    setCookies,
    refreshToken: cookieValue(setCookies, 'pp_refresh'),
    csrfToken: cookieValue(setCookies, 'pp_csrf'),
  };
}

function loginAsAdmin(): Promise<LoginResult> {
  return login(ADMIN_EMAIL, ADMIN_PASSWORD);
}

function loginAsAgent(): Promise<LoginResult> {
  return login(AGENT_EMAIL, AGENT_PASSWORD);
}

function refreshOnlyCookie(loginResult: LoginResult): string {
  return [
    `pp_refresh=${loginResult.refreshToken}`,
    `pp_csrf=${loginResult.csrfToken}`,
  ].join('; ');
}

describe('professional session refresh rotation', () => {
  it('keeps the login active when the same browser repeats a just-rotated refresh', async () => {
    const loginResult = await loginAsAdmin();
    expect(loginResult.response.status).toBe(200);
    expect(loginResult.refreshToken).toBeTruthy();

    const firstRefresh = await workerFetch('/auth/session', {
      headers: { Cookie: refreshOnlyCookie(loginResult) },
    });
    const firstCookies = getSetCookieValues(firstRefresh.headers);

    expect(firstRefresh.status).toBe(200);
    expect(cookieValue(firstCookies, 'pp_session')).toBeTruthy();
    expect(cookieValue(firstCookies, 'pp_refresh')).toBeTruthy();
    expect(cookieValue(firstCookies, 'pp_csrf')).toBeTruthy();

    const repeatedRefresh = await workerFetch('/auth/session', {
      headers: { Cookie: refreshOnlyCookie(loginResult) },
    });
    const repeatedCookies = getSetCookieValues(repeatedRefresh.headers);

    expect(repeatedRefresh.status).toBe(200);
    expect(cookieValue(repeatedCookies, 'pp_session')).toBeTruthy();
    expect(cookieValue(repeatedCookies, 'pp_refresh')).toBe('');
    expect(repeatedCookies.join('\n')).not.toContain('pp_refresh=;');
    expect(repeatedCookies.join('\n')).not.toContain('pp_csrf=;');

    const continuedSession = await workerFetch('/auth/session', {
      headers: { Cookie: cookieHeader(firstCookies) },
    });
    expect(continuedSession.status).toBe(200);
  });

  it('refreshes concurrent administrator dashboard reads before role enforcement', async () => {
    const loginResult = await loginAsAdmin();
    expect(loginResult.response.status).toBe(200);

    const cookie = refreshOnlyCookie(loginResult);
    const [districts, users] = await Promise.all([
      workerFetch('/auth/admin-districts', { headers: { Cookie: cookie } }),
      workerFetch('/auth/admin-users', { headers: { Cookie: cookie } }),
    ]);

    expect(districts.status).toBe(200);
    expect(users.status).toBe(200);

    const districtsBody = await districts.clone().json() as { success?: boolean };
    const usersBody = await users.clone().json() as { success?: boolean };
    expect(districtsBody.success).toBe(true);
    expect(usersBody.success).toBe(true);

    const responseCookies = [
      ...getSetCookieValues(districts.headers),
      ...getSetCookieValues(users.headers),
    ];
    expect(cookieValue(responseCookies, 'pp_session')).toBeTruthy();
    expect(responseCookies.join('\n')).not.toContain('pp_refresh=;');
    expect(responseCookies.join('\n')).not.toContain('pp_csrf=;');
  });

  it('refreshes concurrent agent dashboard profile and listing reads', async () => {
    const loginResult = await loginAsAgent();
    expect(loginResult.response.status).toBe(200);

    const cookie = refreshOnlyCookie(loginResult);
    const [profile, listings] = await Promise.all([
      workerFetch('/auth/profile-settings', { headers: { Cookie: cookie } }),
      workerFetch('/auth/my-listings', { headers: { Cookie: cookie } }),
    ]);

    expect(profile.status).toBe(200);
    expect(listings.status).toBe(200);

    const profileBody = await profile.clone().json() as { success?: boolean };
    const listingsBody = await listings.clone().json() as { success?: boolean };
    expect(profileBody.success).toBe(true);
    expect(listingsBody.success).toBe(true);

    const responseCookies = [
      ...getSetCookieValues(profile.headers),
      ...getSetCookieValues(listings.headers),
    ];
    expect(cookieValue(responseCookies, 'pp_session')).toBeTruthy();
    expect(responseCookies.join('\n')).not.toContain('pp_refresh=;');
    expect(responseCookies.join('\n')).not.toContain('pp_csrf=;');
  });

  it('still revokes the token family when an old refresh is replayed outside the grace window', async () => {
    const loginResult = await loginAsAdmin();
    expect(loginResult.response.status).toBe(200);

    const firstRefresh = await workerFetch('/auth/session', {
      headers: { Cookie: refreshOnlyCookie(loginResult) },
    });
    const firstCookies = getSetCookieValues(firstRefresh.headers);
    expect(firstRefresh.status).toBe(200);

    const oldHash = await sha256Hex(loginResult.refreshToken);
    await testEnv.DB.prepare(
      "UPDATE sessions SET rotated_at = datetime('now', '-1 minute') WHERE token_hash = ?",
    ).bind(oldHash).run();

    const replay = await workerFetch('/auth/session', {
      headers: { Cookie: refreshOnlyCookie(loginResult) },
    });
    const replayBody = await replay.clone().json() as { message?: string };

    expect(replay.status).toBe(401);
    expect(replayBody.message).toContain('Session reuse was detected');

    const rotatedFamily = await workerFetch('/auth/session', {
      headers: { Cookie: cookieHeader(firstCookies) },
    });
    expect(rotatedFamily.status).toBe(401);
  });
});
