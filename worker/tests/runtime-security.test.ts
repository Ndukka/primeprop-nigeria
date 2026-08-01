import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const ADMIN_EMAIL = 'test-admin@primeprop.invalid';
const ADMIN_PASSWORD = 'TestAdmin123!';

type TestEnv = {
  DB: D1Database;
  IMAGES: R2Bucket;
};

type LoginBody = {
  success: boolean;
  data?: {
    token?: string;
    csrf?: string;
    user?: { id: number; email: string; role: string; name: string };
  };
};

type LoginResult = {
  response: Response;
  body: LoginBody;
  cookieHeader: string;
  refreshToken: string;
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

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function loginAsAdmin(): Promise<LoginResult> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const body = (await response.clone().json()) as LoginBody;
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
    const body = (await login.json()) as { message: string };
    expect(body.message.toLowerCase()).toContain('pending');
  });

  it('does not expose internal ownership or agent phone in the public listing DTO', async () => {
    const response = await workerFetch('/api/listings?page=1&limit=100');
    expect(response.status).toBe(200);

    const body = (await response.json()) as { data: Array<Record<string, any>> };
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

describe('read-only D1 and R2 integrity audit', () => {
  it('rejects unauthenticated inventory access', async () => {
    const response = await workerFetch('/auth/security/storage-audit');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('classifies tracked, untracked, suspicious, and unreferenced objects', async () => {
    const login = await loginAsAdmin();
    const accessToken = login.body.data?.token || '';
    const trackedKey = `images/audit-${crypto.randomUUID()}.jpg`;
    const suspiciousKey = `other/audit-${crypto.randomUUID()}.txt`;
    const trackedBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);

    await testEnv.IMAGES.put(trackedKey, trackedBytes, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await testEnv.IMAGES.put(suspiciousKey, 'not an approved media object', {
      httpMetadata: { contentType: 'text/plain' },
    });
    await testEnv.DB.prepare(
      `INSERT INTO upload_objects
       (user_id, listing_id, object_key, original_name, content_type, size_bytes, folder)
       VALUES (1, NULL, ?, 'audit.jpg', 'image/jpeg', ?, 'images')`
    ).bind(trackedKey, trackedBytes.byteLength).run();

    const response = await workerFetch('/auth/security/storage-audit', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      success: boolean;
      data: {
        readOnly: boolean;
        counts: { r2Objects: number; issues: number; high: number };
        issues: Array<{ category: string; key?: string }>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.readOnly).toBe(true);
    expect(body.data.counts.r2Objects).toBeGreaterThanOrEqual(2);
    expect(body.data.counts.issues).toBeGreaterThan(0);
    expect(body.data.counts.high).toBeGreaterThan(0);
    expect(body.data.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'tracked-but-unreferenced', key: trackedKey }),
      expect.objectContaining({ category: 'r2-untracked', key: suspiciousKey }),
      expect.objectContaining({ category: 'suspicious-object-key', key: suspiciousKey }),
      expect.objectContaining({ category: 'unapproved-r2-content-type', key: suspiciousKey }),
    ]));
  });
});
