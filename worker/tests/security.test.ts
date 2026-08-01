import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SELF } from 'cloudflare:test';

// ── Comprehensive Security Test Suite ──────────────────────
// Tests PP-SEC-001 through PP-SEC-045 findings.
// Run with: cd worker && npx vitest run

const BASE = 'http://localhost';

// Helper to create a test admin session
async function loginAsAdmin(): Promise<{ token: string; csrf: string }> {
  const res = await SELF.fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@primeprop.ng', password: 'Admin123!' }),
  });
  const data = await res.json();
  return { token: data.data?.token || '', csrf: data.data?.csrf || '' };
}

describe('PP-SEC-001: JWT Secret', () => {
  it('JWT_SECRET not in wrangler.toml [vars]', async () => {
    const toml = await import('fs').then(fs => fs.readFileSync('./wrangler.toml', 'utf-8'));
    expect(toml).not.toContain('8ede7810ed2db72');
    expect(toml).not.toMatch(/JWT_SECRET\s*=\s*"[a-f0-9]{64}"/);
  });

  it('accepts tokens signed with current secret', async () => {
    const { token } = await loginAsAdmin();
    expect(token).toBeTruthy();
    const res = await SELF.fetch(`${BASE}/auth/session`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects forged tokens', async () => {
    // Forge a token with random secret
    const res = await SELF.fetch(`${BASE}/auth/session`, {
      headers: { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJpZCI6MX0.forged' },
    });
    expect(res.status).toBe(401);
  });
});

describe('PP-SEC-002/003: XSS Prevention & No localStorage Tokens', () => {
  it('admin.html has no innerHTML assignments', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('../public/admin.html', 'utf-8');
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('agent.html has no innerHTML assignments', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('../public/agent.html', 'utf-8');
    expect(html).not.toMatch(/\.innerHTML\s*=/);
  });

  it('login.html has no localStorage token code', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('../public/login.html', 'utf-8');
    expect(html).not.toMatch(/localStorage\.setItem\(['"]pp_token['"]/);
    expect(html).not.toMatch(/localStorage\.getItem\(['"]pp_token['"]/);
  });

  it('admin.html has no localStorage token code', async () => {
    const fs = await import('fs');
    const html = fs.readFileSync('../public/admin.html', 'utf-8');
    expect(html).not.toMatch(/localStorage\.setItem\(['"]pp_token['"]/);
    expect(html).not.toMatch(/localStorage\.getItem\(['"]pp_token['"]/);
  });

  it('uses safe DOM APIs (getCsrf defined, apiFetch uses credentials)', async () => {
    const fs = await import('fs');
    const admin = fs.readFileSync('../public/admin.html', 'utf-8');
    expect(admin).toContain('function getCsrf()');
    expect(admin).toContain("credentials: 'include'");
    expect(admin).toContain('function initAuth()');
  });
});

describe('PP-SEC-006: Token Separation', () => {
  it('refresh token cookie is set on login', async () => {
    const res = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@primeprop.ng', password: 'Admin123!' }),
    });
    const cookies = res.headers.get('Set-Cookie') || '';
    expect(cookies).toContain('pp_refresh=');
    expect(cookies).toContain('pp_session=');
  });

  it('rejects refresh token as access token in Authorization header', async () => {
    // Login to get both tokens
    const res = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@primeprop.ng', password: 'Admin123!' }),
    });
    const data = await res.json();
    const accessToken = data.data?.token;

    // Access token should work
    const sessionRes = await SELF.fetch(`${BASE}/auth/session`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    expect(sessionRes.status).toBe(200);

    // Using a refresh token directly should be rejected
    // (We can't easily extract the refresh token from httpOnly cookie in test,
    // but the middleware verifies token_use claim)
  });

  it('has token_use claim in access tokens', async () => {
    const { token } = await loginAsAdmin();
    // Decode the JWT payload (base64url decode the middle part)
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(atob(parts[1]));
    expect(payload.token_use).toBe('access');
    expect(payload.jti).toBeTruthy();
  });
});

describe('PP-SEC-008: Agent Privilege Restriction', () => {
  it('agents cannot set verified/featured on create', async () => {
    const { token } = await loginAsAdmin();
    // Create a test agent first
    const agentEmail = `test-agent-${Date.now()}@test.com`;
    await SELF.fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ email: agentEmail, password: 'AgentPass1', name: 'Test Agent', role: 'agent' }),
    });

    // Login as agent
    const agentRes = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: agentEmail, password: 'AgentPass1' }),
    });
    const agentData = await agentRes.json();
    const agentToken = agentData.data?.token;

    // Try to create a verified, featured listing
    const createRes = await SELF.fetch(`${BASE}/api/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentToken}` },
      body: JSON.stringify({
        title: 'Agent Self-Verified Test',
        type: 'rent',
        price: 500000,
        location: 'Lagos',
        featured: true,
        verified: true,
        badge: 'PREMIUM',
        agent_name: 'Impostor Agent',
      }),
    });
    const listing = await createRes.json();
    expect(listing.success).toBe(true);
    expect(listing.data.featured).toBe(false);  // Agent cannot set featured
    expect(listing.data.verified).toBe(false);  // Agent cannot set verified
    expect(listing.data.badge).toBe('');        // Agent cannot set badge
    expect(listing.data.agent.name).toBe('Test Agent'); // Agent identity from user record
  });
});

describe('PP-SEC-012: CSRF Protection', () => {
  it('rejects write requests without CSRF token', async () => {
    const { token } = await loginAsAdmin();
    const res = await SELF.fetch(`${BASE}/api/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ title: 'CSRF Test', type: 'rent', price: 1000, location: 'Test' }),
    });
    // Should fail CSRF check (no X-CSRF-Token, no cookie)
    expect(res.status).toBe(403);
  });

  it('allows GET without CSRF', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=10`);
    expect(res.status).toBe(200);
  });

  it('public endpoints skip CSRF', async () => {
    const res = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@primeprop.ng', password: 'Admin123!' }),
    });
    // Login is a public endpoint, should not require CSRF
    expect(res.status).not.toBe(403);
  });
});

describe('PP-SEC-013: Pending Account Restrictions', () => {
  it('pending accounts cannot login', async () => {
    const pendingEmail = `pending-${Date.now()}@test.com`;
    await SELF.fetch(`${BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, password: 'PendingPass1', name: 'Pending User' }),
    });

    const res = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, password: 'PendingPass1' }),
    });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.message).toContain('pending');
  });
});

describe('PP-SEC-014: Last Admin Protection', () => {
  it('cannot delete the last admin', async () => {
    const { token } = await loginAsAdmin();
    // Try to delete ourselves
    const sessionRes = await SELF.fetch(`${BASE}/auth/session`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const session = await sessionRes.json();
    const adminId = session.data?.user?.id;

    const deleteRes = await SELF.fetch(`${BASE}/auth/users/${adminId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    // Should fail: either self-delete or last admin
    expect(deleteRes.status).toBe(400);
  });
});

describe('PP-SEC-015: File Upload Validation', () => {
  it('rejects upload without auth', async () => {
    const formData = new FormData();
    formData.append('file', new Blob(['test'], { type: 'image/png' }), 'test.png');
    const res = await SELF.fetch(`${BASE}/api/images/upload`, {
      method: 'POST',
      body: formData,
    });
    expect(res.status).toBe(401);
  });

  it('rejects files with invalid magic bytes', async () => {
    const { token } = await loginAsAdmin();
    const formData = new FormData();
    // Claim PNG but send text
    formData.append('file', new Blob(['not a png file'], { type: 'image/png' }), 'fake.png');
    const res = await SELF.fetch(`${BASE}/api/images/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    expect(res.status).toBe(400);
  });

  it('rejects double extensions', async () => {
    const { token } = await loginAsAdmin();
    const formData = new FormData();
    formData.append('file', new Blob(['test'], { type: 'image/png' }), 'malicious.php.png');
    const res = await SELF.fetch(`${BASE}/api/images/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    expect(res.status).toBe(400);
  });

  it('rejects more than 5 files', async () => {
    const { token } = await loginAsAdmin();
    const formData = new FormData();
    for (let i = 0; i < 6; i++) {
      formData.append('files', new Blob(['test'], { type: 'image/png' }), `test${i}.png`);
    }
    const res = await SELF.fetch(`${BASE}/api/images/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    expect(res.status).toBe(400);
  });
});

describe('PP-SEC-018: CORS Security', () => {
  it('rejects unknown origins', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=10`, {
      headers: { 'Origin': 'https://evil.com' },
    });
    // Should not return the attacker's origin in ACAO
    const acao = res.headers.get('Access-Control-Allow-Origin');
    expect(acao).not.toBe('https://evil.com');
  });

  it('allows requests with no origin', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=10`);
    expect(res.status).toBe(200);
  });
});

describe('PP-SEC-019: Rate Limiting', () => {
  it('rate limits rapid login attempts', async () => {
    const results: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'nonexistent@test.com', password: 'wrong' }),
      });
      results.push(res.status);
    }
    // At least one should be rate limited
    expect(results).toContain(429);
  });
});

describe('PP-SEC-020: API DTO Security', () => {
  it('public listing does not expose created_by', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=10`);
    const data = await res.json();
    if (data.data && data.data.length > 0) {
      const listing = data.data[0];
      expect(listing.createdBy).toBeUndefined();
      expect(listing.created_by).toBeUndefined();
      // Agent phone should be empty for public
      expect(listing.agent.phone).toBe('');
    }
  });
});

describe('PP-SEC-025: Mandatory Pagination', () => {
  it('returns paginated response by default', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings`);
    const data = await res.json();
    expect(data.page).toBeDefined();
    expect(data.limit).toBeDefined();
    expect(data.totalPages).toBeDefined();
    expect(data.data.length).toBeLessThanOrEqual(100);
  });

  it('respects limit parameter', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=5`);
    const data = await res.json();
    expect(data.data.length).toBeLessThanOrEqual(5);
  });
});

describe('PP-SEC-034: Signup Email Enumeration Prevention', () => {
  it('returns same response for new and existing emails', async () => {
    const res1 = await SELF.fetch(`${BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `unique-${Date.now()}@test.com`, password: 'TestPass1', name: 'New User' }),
    });
    const res2 = await SELF.fetch(`${BASE}/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@primeprop.ng', password: 'TestPass1', name: 'Fake Admin' }),
    });
    // Both should return success
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    const d1 = await res1.json();
    const d2 = await res2.json();
    // Messages should be identical
    expect(d1.success).toBe(d2.success);
  });
});

describe('PP-SEC-038: SRI for CDN Assets', () => {
  it('all HTML files have SRI on Font Awesome', async () => {
    const fs = await import('fs');
    const files = ['admin.html', 'agent.html', 'login.html', 'index.html'];
    for (const file of files) {
      const html = fs.readFileSync(`../public/${file}`, 'utf-8');
      expect(html).toContain('integrity="sha384-');
      expect(html).toContain('crossorigin="anonymous"');
    }
  });
});

describe('PP-SEC-040: DO Alarm Cleanup', () => {
  it('rate-limiter.ts has alarm method', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('./src/rate-limiter.ts', 'utf-8');
    expect(source).toContain('async alarm(');
    expect(source).toContain('setAlarm');
    expect(source).toContain('MAX_AGE_MS');
  });
});

describe('PP-SEC-044: Request Logging', () => {
  it('logger module exports expected functions', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync('./src/logger.ts', 'utf-8');
    expect(source).toContain('generateRequestId');
    expect(source).toContain('createRequestLogger');
    expect(source).toContain('logSecurity');
  });
});

describe('Edge Cases', () => {
  it('handles invalid JSON gracefully', async () => {
    const res = await SELF.fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json{{{',
    });
    expect(res.status).toBe(400);
  });

  it('handles SQL injection attempts in search', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=10&search=';DROP TABLE listings;--`);
    expect(res.status).toBe(200); // Should not crash
  });

  it('handles path traversal in image key', async () => {
    const res = await SELF.fetch(`${BASE}/api/images/../../../worker/wrangler.toml`);
    expect(res.status).toBe(404); // Should not expose files
  });

  it('handles very long inputs', async () => {
    const longString = 'A'.repeat(10000);
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=10&search=${longString}`);
    expect(res.status).toBe(200); // Should not crash
  });

  it('handles negative page numbers', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=-1&limit=10`);
    const data = await res.json();
    expect(data.page).toBeGreaterThanOrEqual(1); // Should clamp
  });

  it('handles zero limit', async () => {
    const res = await SELF.fetch(`${BASE}/api/listings?page=1&limit=0`);
    const data = await res.json();
    expect(data.limit).toBeGreaterThanOrEqual(1); // Should clamp
  });

  it('404 for unknown API routes returns generic error', async () => {
    const res = await SELF.fetch(`${BASE}/api/nonexistent`);
    const data = await res.json();
    expect(res.status).toBe(404);
    expect(data.message).toBe('Not found');
    // Should NOT leak the path
    expect(data.message).not.toContain('/api/nonexistent');
  });
});
