import { describe, expect, it } from 'vitest';
import { env, exports } from 'cloudflare:workers';

const BASE = 'https://primeprop-worker.ndupsn.workers.dev';
const testEnv = env as unknown as {
  DB: D1Database;
  IMAGES: R2Bucket;
};

type LoginSession = {
  cookies: string;
  csrf: string;
};

function getSetCookieValues(headers: Headers): string[] {
  const compatible = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof compatible.getSetCookie === 'function') return compatible.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function cookieHeader(setCookies: string[]): string {
  return setCookies.map(value => value.split(';', 1)[0]).join('; ');
}

async function workerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE}${path}`, init));
}

async function loginSession(email: string, password: string): Promise<LoginSession> {
  const response = await workerFetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(response.status).toBe(200);
  const body = await response.clone().json() as { data: { csrf: string } };
  return {
    cookies: cookieHeader(getSetCookieValues(response.headers)),
    csrf: body.data.csrf,
  };
}

function mutationHeaders(session: LoginSession): HeadersInit {
  return {
    Cookie: session.cookies,
    Origin: BASE,
    'X-CSRF-Token': session.csrf,
    'Content-Type': 'application/json',
  };
}

async function setUserStatus(
  admin: LoginSession,
  accountStatus: 'active' | 'banned',
): Promise<Response> {
  return workerFetch('/auth/users/2', {
    method: 'PUT',
    headers: mutationHeaders(admin),
    body: JSON.stringify({ account_status: accountStatus }),
  });
}

function tinyPng(): Uint8Array {
  // Complete 1x1 transparent PNG. The retrieval test does not depend on the
  // upload validator, but using a valid image keeps the fixture realistic.
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 0, 1, 0, 0, 0, 1,
    8, 6, 0, 0, 0, 31, 21, 196,
    137, 0, 0, 0, 13, 73, 68, 65,
    84, 8, 215, 99, 248, 207, 192, 240,
    31, 0, 5, 0, 1, 255, 137, 153,
    61, 29, 0, 0, 0, 0, 73, 69,
    78, 68, 174, 66, 96, 130,
  ]);
}

describe.sequential('suspended-owner media visibility', () => {
  it('hides tracked uploads from public and stale user sessions until unban', async () => {
    const admin = await loginSession('test-admin@primeprop.invalid', 'TestAdmin123!');
    const agent = await loginSession('test-agent@primeprop.invalid', 'TestAgent123!');
    const key = `listings/images/${crypto.randomUUID()}.png`;
    const bytes = tinyPng();

    await testEnv.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
    });
    await testEnv.DB.prepare(
      `INSERT INTO upload_objects
       (user_id, object_key, original_name, content_type, size_bytes, folder)
       VALUES (2, ?, 'suspended-owner.png', 'image/png', ?, 'images')`,
    ).bind(key, bytes.byteLength).run();

    try {
      const beforeBan = await workerFetch(`/api/images/${key}`);
      expect(beforeBan.status).toBe(200);
      expect(beforeBan.headers.get('content-type')).toContain('image/png');
      expect(beforeBan.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      expect(beforeBan.headers.get('vary')).toContain('Cookie');
      expect(new Uint8Array(await beforeBan.arrayBuffer())).toEqual(bytes);

      const ban = await setUserStatus(admin, 'banned');
      expect(ban.status).toBe(200);

      const [publicResponse, staleAgentResponse, headResponse, adminResponse] = await Promise.all([
        workerFetch(`/api/images/${key}`),
        workerFetch(`/api/images/${key}`, { headers: { Cookie: agent.cookies } }),
        workerFetch(`/api/images/${key}`, { method: 'HEAD' }),
        workerFetch(`/api/images/${key}`, { headers: { Cookie: admin.cookies } }),
      ]);

      expect(publicResponse.status).toBe(404);
      expect(await publicResponse.json()).toEqual({ success: false, message: 'Not found' });
      expect(publicResponse.headers.get('cache-control')).toBe('no-store');

      expect(staleAgentResponse.status).toBe(404);
      expect(await staleAgentResponse.json()).toEqual({ success: false, message: 'Not found' });

      expect(headResponse.status).toBe(404);
      expect(await headResponse.text()).toBe('');
      expect(headResponse.headers.get('cache-control')).toBe('no-store');

      expect(adminResponse.status).toBe(200);
      expect(adminResponse.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      expect(new Uint8Array(await adminResponse.arrayBuffer())).toEqual(bytes);

      const unban = await setUserStatus(admin, 'active');
      expect(unban.status).toBe(200);

      const restored = await workerFetch(`/api/images/${key}`);
      expect(restored.status).toBe(200);
      expect(restored.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
      expect(new Uint8Array(await restored.arrayBuffer())).toEqual(bytes);
    } finally {
      await testEnv.DB.batch([
        testEnv.DB.prepare("UPDATE users SET account_status = 'active' WHERE id = 2"),
        testEnv.DB.prepare('DELETE FROM upload_objects WHERE object_key = ?').bind(key),
      ]);
      await testEnv.IMAGES.delete(key);
    }
  });

  it('preserves legacy untracked R2 objects', async () => {
    const key = `legacy/${crypto.randomUUID()}.png`;
    const bytes = tinyPng();
    await testEnv.IMAGES.put(key, bytes, {
      httpMetadata: { contentType: 'image/png' },
    });

    try {
      const response = await workerFetch(`/api/images/${key}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).not.toBe('private, max-age=0, must-revalidate');
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await testEnv.IMAGES.delete(key);
    }
  });
});
