import { describe, expect, it } from 'vitest';
import { exports } from 'cloudflare:workers';

const BASE = 'https://primeprop.test';
const ADMIN_EMAIL = 'test-admin@primeprop.invalid';
const ADMIN_PASSWORD = 'TestAdmin123!';

type LoginResult = {
  response: Response;
  body: {
    success: boolean;
    data?: {
      token?: string;
      csrf?: string;
      user?: { id: number; email: string; role: string; name: string };
    };
  };
  cookieHeader: string;
  refreshToken: string;
};

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

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function loginAsAdmin(): Promise<LoginResult> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const body = await response.clone().json<LoginResult['body']>();
  const setCookies = getSetCookieValues(response.headers);
  const cookieHeader = setCookies.map(value => value.split(';', 1)[0]).join('; ');

  return {
    response,
    body,
    cookieHeader,
    refreshToken: cookieValue(setCookies, 'pp_refresh'),
  };
}

describe('authentication runtime controls', () => {
  it('issues access and refresh cookies from the isolated test account', async () => {
    const login = await loginAsAdmin();

    expect(login.response.status).toBe(200);
    expect(login.body.success).toBe(true);
    expect(login.body.data?.user?.role).toBe('admin');
    expect(login.cookieHeader).toContain('pp_session=');
    expect(login.cookieHeader).toContain('pp_refresh=');
    expect(login.cookieHeader).toContain('pp_csrf=');
  });

  it('rejects a refresh token when it is presented as an access bearer token', async () => {
    const login = await loginAsAdmin();
    expect(login.refreshToken).toBeTruthy();

    const response = await workerFetch('/auth/session', {
      headers: { Authorization: `Bearer ${login.refreshToken}` },
    });

    expect(response.status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const response = await workerFetch('/auth/session', {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.invalid' },
    });

    expect(response.status).toBe(401);
  });

  it('requires CSRF for cookie-authenticated writes', async () => {
    const login = await loginAsAdmin();

    const response = await workerFetch('/api/listings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: login.cookieHeader,
        Origin: BASE,
      },
      body: JSON.stringify({ title: 'Cookie CSRF test', type: 'rent', price: 500000, location: 'Lagos' }),
    });

    expect(response.status).toBe(403);
  });

  it('accepts a matching CSRF header for cookie-authenticated writes', async () => {
    const login = await loginAsAdmin();

    const response = await workerFetch('/api/listings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: login.cookieHeader,
        Origin: BASE,
        'X-CSRF-Token': login.body.data?.csrf || '',
      },
      body: JSON.stringify({ title: 'Valid CSRF test', type: 'rent', price: 500000, location: 'Lagos' }),
    });

    expect(response.status).toBe(201);
  });

  it('allows a bearer-only API client without browser CSRF state', async () => {
    const login = await loginAsAdmin();
    const accessToken = login.body.data?.token || '';

    const response = await workerFetch('/api/listings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ title: 'Bearer client test', type: 'sale', price: 1500000, location: 'Abuja' }),
    });

    expect(response.status).toBe(201);
  });
});

describe('account and response restrictions', () => {
  it('keeps public signups pending and denies login until approval', async () => {
    const email = `pending-${crypto.randomUUID()}@example.invalid`;

    const signup = await workerFetch('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'PendingTest123!', name: 'Pending Test User' }),
    });
    expect(signup.status).toBe(201);

    const login = await workerFetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'PendingTest123!' }),
    });

    expect(login.status).toBe(403);
    expect((await login.json<{ message: string }>()).message.toLowerCase()).toContain('pending');
  });

  it('does not expose internal ownership or agent phone in the public listing DTO', async () => {
    const response = await workerFetch('/api/listings?page=1&limit=100');
    expect(response.status).toBe(200);

    const body = await response.json<{ data: Array<Record<string, any>> }>();
    for (const listing of body.data) {
      expect(listing.created_by).toBeUndefined();
      expect(listing.createdBy).toBeUndefined();
      expect(listing.agent?.phone).toBe('');
    }
  });

  it('does not reflect an unapproved CORS origin', async () => {
    const response = await workerFetch('/api/listings?page=1&limit=5', {
      headers: { Origin: 'https://evil.example' },
    });

    expect(response.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example');
  });
});
