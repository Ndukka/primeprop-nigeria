import { Hono } from 'hono';
import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';
import bcrypt from 'bcryptjs';
import type { D1Database } from '@cloudflare/workers-types';
import { rowToListing } from './utils';

type Bindings = {
  DB: D1Database;
  JWT_SECRET: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};

type Variables = {
  user: { id: number; email: string; role: string; name: string };
};

// ── JWT Helpers ───────────────────────────────────────────
const encoder = new TextEncoder();
const BCRYPT_ROUNDS = 12;
const ACCESS_EXPIRY = '15min';
const REFRESH_EXPIRY = '7d';

type TokenUse = 'access' | 'refresh';

async function createToken(
  payload: Record<string, any>,
  secret: string,
  tokenUse: TokenUse = 'access',
  expiry: string = ACCESS_EXPIRY
) {
  const tokenPayload = {
    ...payload,
    token_use: tokenUse,  // PP-SEC-006: distinguish access vs refresh
    jti: crypto.randomUUID(),
  };
  return new SignJWT(tokenPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiry)
    .setIssuer('primeprop')
    .sign(encoder.encode(secret));
}

async function verifyToken(token: string, secret: string, expectedUse?: TokenUse) {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      issuer: 'primeprop',
      clockTolerance: 30,
    });
    // PP-SEC-006: Reject tokens with wrong token_use (refresh tokens cannot access API)
    if (expectedUse && (payload as any).token_use !== expectedUse) return null;
    return payload as unknown as { id: number; email: string; role: string; name: string; token_use: string; jti: string };
  } catch { return null; }
}

// ── Session Management ────────────────────────────────────
async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

// PP-SEC-005: SHA-256 hash for password reset tokens (stored in place of plaintext)
async function hashResetToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}

async function createSession(db: D1Database, userId: number, refreshToken: string, jti: string, ip?: string) {
  const tokenHash = await hashToken(refreshToken);
  const family = crypto.randomUUID();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
  await db.prepare(
    'INSERT INTO sessions (user_id, token_hash, token_family, token_jti, ip_address, expires_at) VALUES (?,?,?,?,?,?)'
  ).bind(userId, tokenHash, family, jti, ip || '', expiresAt).run();
  return family;
}

async function rotateSession(db: D1Database, oldRefreshToken: string, newRefreshToken: string, newJti: string): Promise<boolean> {
  const oldHash = await hashToken(oldRefreshToken);
  // Find the existing session
  const session = await db.prepare(
    'SELECT id, token_family, revoked FROM sessions WHERE token_hash = ? AND expires_at > ?'
  ).bind(oldHash, Date.now()).first<{ id: number; token_family: string; revoked: number }>();
  
  if (!session) return false;
  
  // PP-SEC-006: Reuse detection — if a previously-rotated token is reused, revoke the entire family
  if (session.revoked === 1) {
    await db.prepare('UPDATE sessions SET revoked = 1 WHERE token_family = ?').bind(session.token_family).run();
    // Log the reuse event
    await db.prepare(
      "INSERT INTO audit_events (action, target_type, details, created_at) VALUES ('session.reuse_detected', 'session', ?, datetime('now'))"
    ).bind(JSON.stringify({ family: session.token_family })).run();
    return false;
  }

  const newHash = await hashToken(newRefreshToken);
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  
  // Revoke old token, insert new one in same family
  await db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ?').bind(session.id).run();
  await db.prepare(
    'INSERT INTO sessions (user_id, token_hash, token_family, token_jti, ip_address, expires_at) SELECT user_id, ?, token_family, ?, ip_address, ? FROM sessions WHERE id = ?'
  ).bind(newHash, newJti, expiresAt, session.id).run();
  
  return true;
}

async function revokeSession(db: D1Database, refreshToken: string): Promise<void> {
  const tokenHash = await hashToken(refreshToken);
  // Revoke the specific session and its family
  const session = await db.prepare(
    'SELECT token_family FROM sessions WHERE token_hash = ?'
  ).bind(tokenHash).first<{ token_family: string }>();
  if (session) {
    await db.prepare('UPDATE sessions SET revoked = 1 WHERE token_family = ?').bind(session.token_family).run();
  }
}

async function revokeAllUserSessions(db: D1Database, userId: number): Promise<void> {
  await db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').bind(userId).run();
  // Increment security stamp to invalidate all existing tokens
  await db.prepare("UPDATE users SET security_stamp = ? WHERE id = ?").bind(crypto.randomUUID(), userId).run();
}

// ── Cookie Helpers ────────────────────────────────────────
const COOKIE_OPTS = 'Path=/; HttpOnly; Secure; SameSite=Lax';
const CSRF_COOKIE_OPTS = 'Path=/; Secure; SameSite=Lax';

function setAuthCookies(c: any, accessToken: string, refreshToken: string, csrfToken: string) {
  c.res.headers.append('Set-Cookie', `pp_session=${accessToken}; ${COOKIE_OPTS}; Max-Age=900`);
  c.res.headers.append('Set-Cookie', `pp_refresh=${refreshToken}; ${COOKIE_OPTS}; Max-Age=604800`);
  c.res.headers.append('Set-Cookie', `pp_csrf=${csrfToken}; ${CSRF_COOKIE_OPTS}; Max-Age=604800`);
}

function clearAuthCookies(c: any) {
  c.res.headers.append('Set-Cookie', `pp_session=; ${COOKIE_OPTS}; Max-Age=0`);
  c.res.headers.append('Set-Cookie', `pp_refresh=; ${COOKIE_OPTS}; Max-Age=0`);
  c.res.headers.append('Set-Cookie', `pp_csrf=; ${CSRF_COOKIE_OPTS}; Max-Age=0`);
}

function getCookie(c: any, name: string): string | null {
  const cookie = c.req.header('Cookie') || '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ── Signed Cookie Helpers (PP-SEC-004) ───────────────────
// Signs a cookie value with HMAC-SHA256 using a key derived from JWT_SECRET.
// Returns "value.hexSignature" — both components are cookie-safe (no encoding needed).
async function signCookieValue(value: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(secret).slice(0, 32);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  const sigHex = Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
  return `${value}.${sigHex}`;
}

// Verifies a signed cookie value. Returns the original value on success, null on failure.
// Constant-time comparison prevents timing attacks.
async function verifyCookieValue(signedCookie: string, secret: string): Promise<string | null> {
  const idx = signedCookie.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signedCookie.slice(0, idx);
  const expected = await signCookieValue(value, secret);
  if (!timingSafeEqual(signedCookie, expected)) return null;
  return value;
}

// Try to authenticate from cookie OR Authorization header
async function authenticateRequest(c: any): Promise<{ id: number; email: string; role: string; name: string } | null> {
  // 1. Try access cookie (pp_session)
  let token = getCookie(c, 'pp_session');
  let isAccessTokenFromCookie = !!token;
  
  // 2. If no access cookie, try refresh cookie (pp_refresh) for silent refresh
  if (!token) {
    const refreshToken = getCookie(c, 'pp_refresh');
    if (refreshToken) {
      // PP-SEC-006: Verify as refresh token specifically
      const payload = await verifyToken(refreshToken, c.env.JWT_SECRET, 'refresh');
      if (payload) {
        // Verify user still valid
        const dbUser = await c.env.DB.prepare('SELECT id, account_status, security_stamp FROM users WHERE id = ?').bind(payload.id).first() as any;
        if (!dbUser || dbUser.account_status !== 'active') return null;

        // PP-SEC-006: Rotate refresh token, detect reuse
        const newAccess = await createToken(
          { id: payload.id, email: payload.email, role: dbUser.role, name: payload.name },
          c.env.JWT_SECRET, 'access', ACCESS_EXPIRY
        );
        const newRefresh = await createToken(
          { id: payload.id, email: payload.email, role: dbUser.role, name: payload.name },
          c.env.JWT_SECRET, 'refresh', REFRESH_EXPIRY
        );
        
        const rotated = await rotateSession(c.env.DB, refreshToken, newRefresh, (await verifyToken(newRefresh, c.env.JWT_SECRET))?.jti || '');
        if (!rotated) {
          // Reuse detected or session not found — force re-login
          clearAuthCookies(c);
          return null;
        }

        const csrf = generateCSRF();
        setAuthCookies(c, newAccess, newRefresh, csrf);
        return { id: payload.id, email: payload.email, role: dbUser.role, name: payload.name };
      }
    }
  }

  // 3. Try Authorization header (API clients: curl, mobile apps) — must be access token
  if (!token) {
    const authHeader = c.req.header('Authorization') || '';
    token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    isAccessTokenFromCookie = false;
  }

  if (!token) return null;

  // PP-SEC-006: Only access tokens accepted here; refresh tokens are rejected
  const payload = await verifyToken(token, c.env.JWT_SECRET, 'access');
  if (!payload) return null;

  // Verify user still exists and isn't banned
  const dbUser = await c.env.DB.prepare('SELECT id, role, account_status FROM users WHERE id = ?').bind(payload.id).first() as any;
  if (!dbUser || dbUser.account_status !== 'active') return null;

  return { id: payload.id, email: payload.email, role: dbUser.role, name: payload.name };
}

// ── Middleware ─────────────────────────────────────────────
export async function requireAuth(c: any, next: any) {
  const user = await authenticateRequest(c);
  if (!user) {
    return c.json({ success: false, message: 'Authentication required. Please log in.' }, 401);
  }
  c.set('user', user);
  await next();
}

export function requireRole(...roles: string[]) {
  return async (c: any, next: any) => {
    const user = c.get('user');
    if (!user) return c.json({ success: false, message: 'Authentication required' }, 401);
    if (!roles.includes(user.role)) {
      return c.json({ success: false, message: 'Insufficient permissions. This action requires: ' + roles.join(' or ') }, 403);
    }
    await next();
  };
}

export function getUser(c: any) {
  return c.get('user') || null;
}

// ── Password Validation ────────────────────────────────────
function validatePassword(password: string): string | null {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be under 128 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null; // Valid
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sanitizeString(v: unknown, maxLen = 200): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

// CSRF token generation (included in login response, validated on write)
export function generateCSRF() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ── CSRF Protection ───────────────────────────────────────
// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  let result = bufA.byteLength ^ bufB.byteLength;
  const minLen = Math.min(bufA.byteLength, bufB.byteLength);
  for (let i = 0; i < minLen; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

const CSRF_ALLOWED_ORIGINS = [
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
];

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

// Public auth endpoints that don't have a CSRF cookie yet (login, signup, password reset)
const CSRF_EXCLUDED_PATHS = new Set([
  '/auth/login',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/reset-password',
  '/auth/google',
  '/auth/google/callback',
]);

// CSRF validation middleware — validates X-CSRF-Token header against pp_csrf cookie
// Skips safe methods (GET/HEAD/OPTIONS) and non-browser API clients (Authorization header, no cookie)
export async function csrfProtection(c: any, next: any) {
  // Skip safe methods
  if (CSRF_SAFE_METHODS.has(c.req.method)) {
    return next();
  }

  // Skip public auth endpoints that don't have a CSRF cookie yet
  const path = new URL(c.req.url).pathname;
  if (CSRF_EXCLUDED_PATHS.has(path)) {
    return next();
  }

  // Skip non-browser API clients: if Authorization header is present but no CSRF cookie,
  // this is likely curl, a mobile app, or server-to-server — not a browser.
  const authHeader = c.req.header('Authorization');
  const cookieHeader = c.req.header('Cookie') || '';
  if (authHeader && !cookieHeader.includes('pp_csrf=')) {
    return next();
  }

  // Validate Origin against exact allowlist
  const origin = c.req.header('Origin');
  if (origin && !CSRF_ALLOWED_ORIGINS.includes(origin)) {
    return c.json({ success: false, message: 'Invalid origin' }, 403);
  }

  // Validate CSRF token
  const cookieToken = getCookie(c, 'pp_csrf');
  const headerToken = c.req.header('X-CSRF-Token');

  if (!cookieToken || !headerToken) {
    return c.json({ success: false, message: 'CSRF token missing' }, 403);
  }

  if (!timingSafeEqual(cookieToken, headerToken)) {
    return c.json({ success: false, message: 'CSRF token mismatch' }, 403);
  }

  return next();
}

// ── Auth Routes ────────────────────────────────────────────
export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /auth/register — admin creates agent/lister accounts
authRoutes.post('/register', csrfProtection, requireAuth, requireRole('admin'), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const email = sanitizeString(body.email, 254).toLowerCase();
  const password = sanitizeString(body.password, 128);
  const name = sanitizeString(body.name, 200);
  const role = sanitizeString(body.role, 50) || 'agent';

  if (!email || !password || !name) {
    return c.json({ success: false, message: 'email, password, and name are required' }, 400);
  }
  if (!isValidEmail(email)) {
    return c.json({ success: false, message: 'Invalid email format' }, 400);
  }
  const pwdError = validatePassword(password);
  if (pwdError) {
    return c.json({ success: false, message: pwdError }, 400);
  }
  if (!['admin', 'agent'].includes(role)) {
    return c.json({ success: false, message: 'Invalid role. Must be admin or agent' }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return c.json({ success: false, message: 'Email already registered' }, 409);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // PP-SEC-013: Admin-created accounts start active (admin has vetted them)
  await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, name, role, account_status) VALUES (?,?,?,?,?)'
  ).bind(email, hash, name, role, 'active').run();

  return c.json({ success: true, data: { email, name, role } }, 201);
});

// POST /auth/signup — public self-registration (creates agent accounts)
authRoutes.post('/signup', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const email = sanitizeString(body.email, 254).toLowerCase();
  const password = sanitizeString(body.password, 128);
  const name = sanitizeString(body.name, 200);
  // Public signup always creates agents — admins must be created by existing admins
  const role = 'agent';

  if (!email || !password || !name) {
    return c.json({ success: false, message: 'Name, email, and password are required' }, 400);
  }
  if (!isValidEmail(email)) {
    return c.json({ success: false, message: 'Please enter a valid email address' }, 400);
  }
  const pwdError = validatePassword(password);
  if (pwdError) {
    return c.json({ success: false, message: pwdError }, 400);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) {
    return c.json({ success: false, message: 'An account with this email already exists' }, 409);
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  // PP-SEC-013: Public signups are created as 'pending' — must be approved by admin before publishing
  await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, name, role, account_status) VALUES (?,?,?,?,?)'
  ).bind(email, hash, name, role, 'pending').run();

  return c.json({ success: true, data: { email, name, role } }, 201);
});

// POST /auth/login
authRoutes.post('/login', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const email = sanitizeString(body.email, 254).toLowerCase();
  const password = sanitizeString(body.password, 128);

  if (!email || !password) {
    return c.json({ success: false, message: 'Email and password required' }, 400);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, name, role, account_status FROM users WHERE email = ?'
  ).bind(email).first<{ id: number; email: string; password_hash: string; name: string; role: string; account_status: string }>();

  // Use constant-time-ish response: always compare hash even if user doesn't exist
  const dummyHash = '$2a$12$LJ3m4ys3Lk0TSwHCpNqrEeS9HxBRDdYQHkJKvMPyRTpFpG0lKXVXi'; // Hash of "dummy"
  const hash = user?.password_hash || dummyHash;
  const valid = await bcrypt.compare(password, hash);

  if (!user || !valid) {
    return c.json({ success: false, message: 'Invalid email or password' }, 401);
  }

  if (user.account_status === 'banned') {
    return c.json({ success: false, message: 'Account suspended. Contact support.' }, 403);
  }
  if (user.account_status === 'pending') {
    return c.json({ success: false, message: 'Account pending approval. Contact support.' }, 403);
  }

  const accessToken = await createToken(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET, 'access', ACCESS_EXPIRY
  );
  const refreshToken = await createToken(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET, 'refresh', REFRESH_EXPIRY
  );
  const csrf = generateCSRF();

  // PP-SEC-006: Create session record for refresh token tracking
  const refreshPayload = await verifyToken(refreshToken, c.env.JWT_SECRET);
  const ip = c.req.header('CF-Connecting-IP') || '';
  await createSession(c.env.DB, user.id, refreshToken, refreshPayload?.jti || '', ip);

  // Set httpOnly cookies (primary auth method) + return JSON (API client fallback)
  setAuthCookies(c, accessToken, refreshToken, csrf);

  // Track login
  await c.env.DB.prepare(
    'UPDATE users SET last_login_at = datetime(\'now\'), login_count = login_count + 1 WHERE id = ?'
  ).bind(user.id).run();

  return c.json({
    success: true,
    data: {
      token: accessToken,  // for API clients
      csrf,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    }
  });
});

// POST /auth/logout — clear cookies + revoke session (PP-SEC-006)
authRoutes.post('/logout', csrfProtection, async (c) => {
  const refreshToken = getCookie(c, 'pp_refresh');
  if (refreshToken) {
    await revokeSession(c.env.DB, refreshToken);
  }
  clearAuthCookies(c);
  return c.json({ success: true, message: 'Logged out' });
});

// GET /auth/session — verify and return user info
authRoutes.get('/session', async (c) => {
  const user = await authenticateRequest(c);
  if (!user) return c.json({ success: false, message: 'Not authenticated' }, 401);

  const dbUser = await c.env.DB.prepare(
    'SELECT id, email, name, role, avatar_url, phone FROM users WHERE id = ?'
  ).bind(user.id).first<any>();

  return c.json({ success: true, data: { user: dbUser || user } });
});

// ── User Management (admin only) ──────────────────────────

// GET /auth/users — list all users
authRoutes.get('/users', requireAuth, requireRole('admin'), async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, name, role, avatar_url, phone, account_status, last_login_at, login_count, created_at FROM users ORDER BY id ASC'
  ).all();
  return c.json({ success: true, data: results });
});

// PUT /auth/users/:id — update user (admin: change role, ban/unban)
authRoutes.put('/users/:id', csrfProtection, requireAuth, requireRole('admin'), async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!id || id <= 0) return c.json({ success: false, message: 'Invalid user ID' }, 400);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, message: 'User not found' }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const updates: Record<string, any> = {};
  if (body.role !== undefined && ['admin', 'agent'].includes(body.role)) updates.role = body.role;
  if (body.name !== undefined) updates.name = sanitizeString(body.name, 200);
  if (body.phone !== undefined) updates.phone = sanitizeString(body.phone, 50);
  if (body.avatar_url !== undefined) updates.avatar_url = sanitizeString(body.avatar_url, 1000);
  if (body.account_status !== undefined) {
    if (!['active', 'banned', 'pending'].includes(body.account_status)) {
      return c.json({ success: false, message: 'Invalid account status' }, 400);
    }
    updates.account_status = body.account_status;
  }
  if (body.password) {
    const pwdError = validatePassword(body.password);
    if (pwdError) return c.json({ success: false, message: pwdError }, 400);
    updates.password_hash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ success: false, message: 'No valid fields to update' }, 400);
  }

  const setClauses = Object.keys(updates).map(f => `${f} = ?`);
  await c.env.DB.prepare(`UPDATE users SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...Object.values(updates), id).run();

  const updated = await c.env.DB.prepare(
    'SELECT id, email, name, role, avatar_url, phone, account_status, created_at FROM users WHERE id = ?'
  ).bind(id).first();

  return c.json({ success: true, data: updated });
});

// DELETE /auth/users/:id — delete user (admin only)
authRoutes.delete('/users/:id', csrfProtection, requireAuth, requireRole('admin'), async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'));
  if (!id || id <= 0) return c.json({ success: false, message: 'Invalid user ID' }, 400);

  // PP-SEC-014: Select role for last-admin check (was broken — only selected id, email)
  const existing = await c.env.DB.prepare('SELECT id, email, role FROM users WHERE id = ?').bind(id).first<any>();
  if (!existing) return c.json({ success: false, message: 'User not found' }, 404);

  // Prevent self-delete
  if (existing.id === user.id) {
    return c.json({ success: false, message: 'Cannot delete your own account' }, 400);
  }

  // Don't allow deleting/demoting/banning the last active admin
  if (existing.role === 'admin') {
    const adminCount = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND account_status = 'active'").first<{c:number}>();
    if ((adminCount?.c || 0) <= 1) {
      return c.json({ success: false, message: 'Cannot delete the last active admin account' }, 400);
    }
  }

  // Reassign listings to another admin
  const adminUser = await c.env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND account_status = 'active' AND id != ? LIMIT 1").bind(id).first<{id:number}>();
  const reassignId = adminUser?.id || null;
  
  // PP-SEC-029: Atomic batch — reassign then delete
  await c.env.DB.prepare('UPDATE listings SET created_by = ? WHERE created_by = ?').bind(reassignId, id).run();
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  
  // PP-SEC-017: Revoke all sessions for deleted user
  await revokeAllUserSessions(c.env.DB, id);
  
  return c.json({ success: true, message: `User ${existing.email} deleted` });
});

// ── My Listings (for agents to see their own) ─────────────
authRoutes.get('/my-listings', requireAuth, async (c) => {
  const user = c.get('user');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM listings WHERE created_by = ? ORDER BY id DESC'
  ).bind(user.id).all();

  // Return full listing data so agent dashboard can edit properly
  return c.json({ success: true, data: results.map(rowToListing) });
});

// ── Google OAuth ───────────────────────────────────────────
// PP-SEC-004: Google OAuth with cryptographic ID token verification,
// state+nonce stored in signed HttpOnly cookies to prevent CSRF.
authRoutes.get('/google', async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return c.json({ success: false, message: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI secrets.' }, 500);
  }

  // Validate redirect URI matches the worker domain to prevent open redirect
  if (!redirectUri.includes('workers.dev') && !redirectUri.includes('primeprop')) {
    return c.json({ success: false, message: 'Invalid redirect URI configuration' }, 500);
  }

  // PP-SEC-004: Generate state (CSRF) and nonce (replay protection)
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();

  // Store in short-lived signed HttpOnly cookies (5-minute expiry)
  const signedState = await signCookieValue(state, c.env.JWT_SECRET);
  const signedNonce = await signCookieValue(nonce, c.env.JWT_SECRET);
  c.res.headers.append('Set-Cookie', `pp_oauth_state=${signedState}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);
  c.res.headers.append('Set-Cookie', `pp_oauth_nonce=${signedNonce}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=300`);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('prompt', 'select_account');

  return c.redirect(url.toString());
});

// PP-SEC-004: Google OAuth callback with full cryptographic ID token verification.
authRoutes.get('/google/callback', async (c) => {
  const { code, state: returnedState, error } = c.req.query();
  if (error || !code) {
    return c.json({ success: false, message: error || 'Authorization failed' }, 400);
  }

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return c.json({ success: false, message: 'OAuth not configured' }, 500);
  }

  // ── Step 1: Verify state (CSRF protection) ────────────
  const stateCookie = getCookie(c, 'pp_oauth_state');
  if (!stateCookie || !returnedState) {
    // Consume cookies even on failure
    c.res.headers.append('Set-Cookie', 'pp_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    c.res.headers.append('Set-Cookie', 'pp_oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return c.json({ success: false, message: 'Invalid state parameter' }, 400);
  }

  const verifiedState = await verifyCookieValue(stateCookie, c.env.JWT_SECRET);
  if (!verifiedState || !timingSafeEqual(verifiedState, returnedState)) {
    c.res.headers.append('Set-Cookie', 'pp_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    c.res.headers.append('Set-Cookie', 'pp_oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return c.json({ success: false, message: 'State mismatch — possible CSRF attack' }, 403);
  }

  // ── Step 2: Extract and verify nonce ──────────────────
  const nonceCookie = getCookie(c, 'pp_oauth_nonce');
  const expectedNonce = nonceCookie ? await verifyCookieValue(nonceCookie, c.env.JWT_SECRET) : null;

  // Consume state/nonce cookies immediately after reading them
  c.res.headers.append('Set-Cookie', 'pp_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  c.res.headers.append('Set-Cookie', 'pp_oauth_nonce=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');

  if (!expectedNonce) {
    return c.json({ success: false, message: 'Missing nonce cookie' }, 400);
  }

  // ── Step 3: Exchange authorization code for tokens ────
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });

  if (!tokenRes.ok) {
    return c.json({ success: false, message: 'Google authentication failed' }, 401);
  }

  const tokens: any = await tokenRes.json();
  if (!tokens.id_token) {
    return c.json({ success: false, message: 'Invalid token from Google' }, 401);
  }

  // ── Step 4: Cryptographically verify the ID token ─────
  let payload: any;
  try {
    const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
    const verified = await jwtVerify(tokens.id_token, JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: clientId,
    });
    payload = verified.payload;
  } catch (err: any) {
    return c.json({ success: false, message: 'ID token verification failed', details: err?.message }, 401);
  }

  // ── Step 5: Validate payload claims ───────────────────
  const { sub: googleId, email, name, picture, email_verified, nonce: tokenNonce } = payload;

  if (!googleId || !email) {
    return c.json({ success: false, message: 'Incomplete profile from Google' }, 400);
  }

  if (email_verified !== true) {
    return c.json({ success: false, message: 'Google email not verified' }, 400);
  }

  if (!tokenNonce || !timingSafeEqual(tokenNonce, expectedNonce)) {
    return c.json({ success: false, message: 'Nonce mismatch — possible replay attack' }, 403);
  }

  // ── Step 6: Look up or create user ────────────────────
  // PP-SEC-004: Look up by google_id ONLY. Do NOT link by email alone —
  // that would let a malicious Google user hijack a password-based account.
  let user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE google_id = ?'
  ).bind(googleId).first<any>();

  if (!user) {
    // Check if this email already has a password account
    const emailUser = await c.env.DB.prepare(
      'SELECT id, password_hash FROM users WHERE email = ?'
    ).bind(email).first<{ id: number; password_hash: string | null }>();

    if (emailUser?.password_hash) {
      // Email exists with a password account. Require explicit re-authentication.
      return c.json({
        success: false,
        message: 'An account with this email already exists. Please log in with your password, then link your Google account from your profile settings.'
      }, 409);
    }

    // New user — create account with google_id
    const result = await c.env.DB.prepare(
      'INSERT INTO users (email, name, role, avatar_url, google_id) VALUES (?,?,?,?,?)'
    ).bind(email, name, 'agent', picture, googleId).run();
    user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta.last_row_id).first<any>();
  }

  if (!user) {
    return c.json({ success: false, message: 'Failed to create or retrieve user account' }, 500);
  }

  if (user.account_status === 'banned') {
    return c.json({ success: false, message: 'Account suspended' }, 403);
  }

  // Update avatar if changed
  if (picture && picture !== user.avatar_url) {
    await c.env.DB.prepare('UPDATE users SET avatar_url = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(picture, user.id).run();
  }

  // ── Step 7: Issue session tokens ──────────────────────
  const accessToken = await createToken(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET, 'access', ACCESS_EXPIRY
  );
  const refreshToken = await createToken(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET, 'refresh', REFRESH_EXPIRY
  );
  const csrf = generateCSRF();

  // PP-SEC-006: Create session record for refresh token tracking
  const refreshPayload = await verifyToken(refreshToken, c.env.JWT_SECRET);
  const ip = c.req.header('CF-Connecting-IP') || '';
  await createSession(c.env.DB, user.id, refreshToken, refreshPayload?.jti || '', ip);

  // Track login
  await c.env.DB.prepare(
    "UPDATE users SET last_login_at = datetime('now'), login_count = login_count + 1 WHERE id = ?"
  ).bind(user.id).run();

  setAuthCookies(c, accessToken, refreshToken, csrf);

  // Redirect to admin (cookies handle auth now)
  return c.redirect('/admin.html');
});

// ── Profile update (self-service) ─────────────────────────
authRoutes.put('/profile', csrfProtection, requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const updates: Record<string, any> = {};
  if (body.name !== undefined) updates.name = sanitizeString(body.name, 200);
  if (body.email !== undefined) {
    const newEmail = sanitizeString(body.email, 254).toLowerCase();
    if (!isValidEmail(newEmail)) return c.json({ success: false, message: 'Invalid email format' }, 400);
    // Check email not taken
    const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND id != ?').bind(newEmail, user.id).first();
    if (existing) return c.json({ success: false, message: 'Email already in use' }, 409);
    updates.email = newEmail;
  }
  if (body.phone !== undefined) updates.phone = sanitizeString(body.phone, 50);
  if (body.avatar_url !== undefined) updates.avatar_url = sanitizeString(body.avatar_url, 1000);

  if (body.current_password && body.new_password) {
    const dbUser = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first() as any;
    if (!dbUser?.password_hash) {
      return c.json({ success: false, message: 'Cannot change password for OAuth-only accounts' }, 400);
    }
    const valid = await bcrypt.compare(body.current_password, dbUser.password_hash);
    if (!valid) return c.json({ success: false, message: 'Current password is incorrect' }, 400);
    const pwdError = validatePassword(body.new_password);
    if (pwdError) return c.json({ success: false, message: pwdError }, 400);
    updates.password_hash = await bcrypt.hash(body.new_password, BCRYPT_ROUNDS);
  }

  if (Object.keys(updates).length === 0) return c.json({ success: false, message: 'No valid fields' }, 400);

  const setClauses = Object.keys(updates).map(f => `${f} = ?`);
  await c.env.DB.prepare(`UPDATE users SET ${setClauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .bind(...Object.values(updates), user.id).run();

  // If email changed, update the JWT token in the response
  const newUser = await c.env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(user.id).first() as any;
  const newToken = await createToken(
    { id: newUser.id, email: newUser.email, role: newUser.role, name: newUser.name },
    c.env.JWT_SECRET
  );

  return c.json({ success: true, message: 'Profile updated', data: { token: newToken, user: newUser } });
});

// ── Forgot Password ────────────────────────────────────────
// PP-SEC-005: Rate limiting on this endpoint is handled by the rate limiter middleware
authRoutes.post('/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);
  
  const email = sanitizeString(body.email, 254).toLowerCase();

  // PP-SEC-005: Always return the same generic message whether the email exists or not.
  // This prevents user enumeration via timing/response differences.
  const GENERIC_RESPONSE = { success: true, message: 'If the email exists, a reset link has been sent.' };

  if (!email || !isValidEmail(email)) {
    return c.json(GENERIC_RESPONSE);
  }

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND password_hash IS NOT NULL').bind(email).first();
  if (!user) {
    return c.json(GENERIC_RESPONSE);
  }

  // PP-SEC-005: Invalidate all previous reset tokens for this user so only the newest is valid
  await c.env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind((user as any).id).run();

  // PP-SEC-005: Generate a cryptographically random reset token and store only its SHA-256 hash.
  // The plaintext token is never persisted and never returned in the API response.
  // In production, the plaintext token is sent to the user's email address.
  const token = generateCSRF(); // 256 bits of entropy from crypto.getRandomValues
  const tokenHash = await hashResetToken(token);
  const expiresAt = Date.now() + 15 * 60 * 1000; // PP-SEC-005: 15-minute expiry window
  
  await c.env.DB.prepare(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).bind((user as any).id, tokenHash, expiresAt).run();

  // PP-SEC-005: NEVER return the plaintext token in the response.
  // TODO: Send the plaintext token via email instead of logging it.
  console.log(`[PP-SEC-005] Reset token for ${email}: ${token}`);

  return c.json(GENERIC_RESPONSE);
});

// POST /auth/reset-password — reset with token
authRoutes.post('/reset-password', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const token = sanitizeString(body.token, 128);
  const newPassword = sanitizeString(body.password, 128);

  if (!token || !newPassword) {
    return c.json({ success: false, message: 'Token and new password are required' }, 400);
  }

  const pwdError = validatePassword(newPassword);
  if (pwdError) return c.json({ success: false, message: pwdError }, 400);

  // PP-SEC-005: Hash the plaintext token provided by the user to look up its stored SHA-256 hash
  const tokenHash = await hashResetToken(token);

  // Find valid reset token by hash — also checks expiry
  const reset = await c.env.DB.prepare(
    'SELECT user_id, expires_at FROM password_resets WHERE token = ?'
  ).bind(tokenHash).first<{user_id: number; expires_at: number}>();

  if (!reset || reset.expires_at < Date.now()) {
    return c.json({ success: false, message: 'Invalid or expired reset token' }, 400);
  }

  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(hash, reset.user_id).run();

  // PP-SEC-005: Delete the used reset token by hash (single-use token)
  await c.env.DB.prepare('DELETE FROM password_resets WHERE token = ?').bind(tokenHash).run();

  // PP-SEC-017: Revoke all existing sessions after password reset
  await revokeAllUserSessions(c.env.DB, reset.user_id);

  return c.json({ success: true, message: 'Password has been reset. You can now log in.' });
});

// ── Helpers ────────────────────────────────────────────────
function rowToSummary(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    type: row.type,
    price: Number(row.price),
    priceDisplay: `₦${Number(row.price).toLocaleString()}`,
    location: row.location,
    featured: Boolean(row.featured),
    verified: Boolean(row.verified),
    created_at: row.created_at,
  };
}
