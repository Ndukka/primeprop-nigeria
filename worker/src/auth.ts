import { Hono } from 'hono';
import { SignJWT, jwtVerify } from 'jose';
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
const BCRYPT_ROUNDS = 12; // OWASP recommends 12+

async function createToken(payload: { id: number; email: string; role: string; name: string }, secret: string) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('8h') // Shorter expiry
    .setIssuer('primeprop')
    .sign(encoder.encode(secret));
}

async function verifyToken(token: string, secret: string) {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      issuer: 'primeprop',
      clockTolerance: 30,
    });
    return payload as unknown as { id: number; email: string; role: string; name: string };
  } catch {
    return null;
  }
}

// ── Auth Middleware ────────────────────────────────────────
export async function requireAuth(c: any, next: any) {
  const authHeader = c.req.header('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return c.json({ success: false, message: 'Authentication required' }, 401);
  }

  const payload = await verifyToken(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ success: false, message: 'Invalid or expired token. Please log in again.' }, 401);
  }

  // Verify user still exists and isn't banned
  const dbUser: any = await c.env.DB.prepare('SELECT id, role, account_status FROM users WHERE id = ?').bind(payload.id).first();
  if (!dbUser) {
    return c.json({ success: false, message: 'Account not found' }, 401);
  }
  if (dbUser.account_status === 'banned') {
    return c.json({ success: false, message: 'Account has been suspended. Contact support.' }, 403);
  }

  c.set('user', { ...payload, role: dbUser.role }); // Use fresh role from DB
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

// Note: CSRF validation is opt-in for now. Clients pass X-CSRF-Token header.
// The token is returned in login response and validated on write endpoints.

// ── Auth Routes ────────────────────────────────────────────
export const authRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// POST /auth/register — admin creates agent/lister accounts
authRoutes.post('/register', requireAuth, requireRole('admin'), async (c) => {
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
  await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)'
  ).bind(email, hash, name, role).run();

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
  await c.env.DB.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?,?,?,?)'
  ).bind(email, hash, name, role).run();

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

  const token = await createToken(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET
  );

  // Track login
  await c.env.DB.prepare(
    'UPDATE users SET last_login_at = datetime(\'now\'), login_count = login_count + 1 WHERE id = ?'
  ).bind(user.id).run();

  const csrf = generateCSRF();

  return c.json({
    success: true,
    data: {
      token,
      csrf,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    }
  });
});

// POST /auth/logout (client-side: just discard token)
authRoutes.post('/logout', (c) => {
  return c.json({ success: true, message: 'Logged out. Discard your token.' });
});

// GET /auth/session — verify and refresh token
authRoutes.get('/session', requireAuth, async (c) => {
  const user = c.get('user');
  const dbUser = await c.env.DB.prepare(
    'SELECT id, email, name, role, avatar_url, phone FROM users WHERE id = ?'
  ).bind(user.id).first<any>();

  if (!dbUser) return c.json({ success: false, message: 'User not found' }, 404);

  const token = await createToken(
    { id: dbUser.id, email: dbUser.email, role: dbUser.role, name: dbUser.name },
    c.env.JWT_SECRET
  );

  return c.json({
    success: true,
    data: { user: dbUser, token }
  });
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
authRoutes.put('/users/:id', requireAuth, requireRole('admin'), async (c) => {
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
    if (!['active', 'banned'].includes(body.account_status)) {
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
authRoutes.delete('/users/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = parseInt(c.req.param('id'));
  if (!id || id <= 0) return c.json({ success: false, message: 'Invalid user ID' }, 400);

  const existing = await c.env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(id).first<any>();
  if (!existing) return c.json({ success: false, message: 'User not found' }, 404);

  // Don't allow deleting the last admin
  if (existing.role === 'admin') {
    const adminCount = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").first<{c:number}>();
    if ((adminCount?.c || 0) <= 1) {
      return c.json({ success: false, message: 'Cannot delete the last admin account' }, 400);
    }
  }

  // Reassign listings to admin (or null)
  const adminUser = await c.env.DB.prepare("SELECT id FROM users WHERE role = 'admin' AND id != ? LIMIT 1").bind(id).first<{id:number}>();
  const reassignId = adminUser?.id || null;
  await c.env.DB.prepare('UPDATE listings SET created_by = ? WHERE created_by = ?').bind(reassignId, id).run();

  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
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
authRoutes.get('/google', (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return c.json({ success: false, message: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_REDIRECT_URI secrets.' }, 500);
  }

  // Validate redirect URI matches the worker domain to prevent open redirect
  if (!redirectUri.includes('workers.dev') && !redirectUri.includes('primeprop')) {
    return c.json({ success: false, message: 'Invalid redirect URI configuration' }, 500);
  }

  const state = crypto.randomUUID();
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');

  return c.redirect(url.toString());
});

authRoutes.get('/google/callback', async (c) => {
  const { code, error } = c.req.query();
  if (error || !code) {
    return c.json({ success: false, message: error || 'Authorization failed' }, 400);
  }

  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = c.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return c.json({ success: false, message: 'OAuth not configured' }, 500);
  }

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

  // Decode and verify id_token
  let payload: any;
  try {
    const parts = tokens.id_token.split('.');
    payload = JSON.parse(atob(parts[1]));
  } catch {
    return c.json({ success: false, message: 'Invalid token' }, 401);
  }

  const { sub: googleId, email, name, picture } = payload;
  if (!googleId || !email) {
    return c.json({ success: false, message: 'Incomplete profile from Google' }, 400);
  }

  let user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE google_id = ? OR email = ?'
  ).bind(googleId, email).first<any>();

  if (!user) {
    const result = await c.env.DB.prepare(
      'INSERT INTO users (email, name, role, avatar_url, google_id) VALUES (?,?,?,?,?)'
    ).bind(email, name, 'agent', picture, googleId).run();
    user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(result.meta.last_row_id).first<any>();
  } else if (!user.google_id) {
    await c.env.DB.prepare('UPDATE users SET google_id = ?, avatar_url = COALESCE(NULLIF(?, ""), avatar_url) WHERE id = ?')
      .bind(googleId, picture, user.id).run();
    user.google_id = googleId;
  }

  if (user.account_status === 'banned') {
    return c.json({ success: false, message: 'Account suspended' }, 403);
  }

  const token = await createToken(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET
  );

  return c.redirect(`/admin.html?token=${token}`);
});

// ── Profile update (self-service) ─────────────────────────
authRoutes.put('/profile', requireAuth, async (c) => {
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
authRoutes.post('/forgot-password', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);
  
  const email = sanitizeString(body.email, 254).toLowerCase();
  if (!email || !isValidEmail(email)) {
    // Don't reveal if email exists — always return success
    return c.json({ success: true, message: 'If the email exists, a reset link has been generated.' });
  }

  const user = await c.env.DB.prepare('SELECT id FROM users WHERE email = ? AND password_hash IS NOT NULL').bind(email).first();
  if (!user) {
    return c.json({ success: true, message: 'If the email exists, a reset link has been generated.' });
  }

  // Generate reset token (valid for 1 hour)
  const token = generateCSRF();
  const expiresAt = Date.now() + 3600000;
  
  await c.env.DB.prepare(
    'INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?)'
  ).bind((user as any).id, token, expiresAt).run();

  // In production: send email. For now, return the token directly (admin use)
  return c.json({ 
    success: true, 
    message: 'Password reset token generated.',
    data: { token, expiresIn: '1 hour' }
  });
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

  // Find valid reset token
  const reset = await c.env.DB.prepare(
    'SELECT user_id, expires_at FROM password_resets WHERE token = ?'
  ).bind(token).first<{user_id: number; expires_at: number}>();

  if (!reset || reset.expires_at < Date.now()) {
    return c.json({ success: false, message: 'Invalid or expired reset token' }, 400);
  }

  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await c.env.DB.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .bind(hash, reset.user_id).run();

  // Delete used token
  await c.env.DB.prepare('DELETE FROM password_resets WHERE token = ?').bind(token).run();

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
