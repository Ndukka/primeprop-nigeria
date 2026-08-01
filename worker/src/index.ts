import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes, requireAuth, requireRole, csrfProtection } from './auth';
import { safeJsonParse, isYouTube, rowToListing, sanitizePositiveInt } from './utils';
import { RateLimiter } from './rate-limiter';
import {
  detectFileType,
  validateFilename,
  getSafeContentType,
  requiresAttachmentDisposition,
  validateImageHeaders,
  getCacheControl,
  ALLOWED_CONTENT_TYPES,
  MAX_IMAGE_SIZE,
  MAX_RISKY_SIZE,
  MAX_FILES_PER_REQUEST,
  MAX_UPLOADS_PER_USER_PER_DAY,
  getR2FolderPrefix,
  isRiskyType,
} from './file-validator';
import type { D1Database, R2Bucket, Fetcher, DurableObjectNamespace } from '@cloudflare/workers-types';
import {
  generateNonce,
  injectNonces,
  setHtmlSecurityHeaders,
  setAssetSecurityHeaders,
  setApiSecurityHeaders,
  isHtmlPath,
} from './security-headers';
import { createRequestLogger } from './logger';

type Bindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
  ASSETS: Fetcher;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;
};

type Variables = {
  user: { id: number; email: string; role: string; name: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── Security Headers (API routes only) ────────────────────
// PP-SEC-010 / PP-SEC-011: HTML pages are handled by the fetch wrapper below
// which injects per-request nonces and sets a strict CSP. This middleware
// only applies to API/auth routes and sets a restrictive CSP appropriate
// for JSON responses.
app.use('*', async (c, next) => {
  await next();
  setApiSecurityHeaders(c.res.headers);
});

// ── CORS ──────────────────────────────────────────────────
// PP-SEC-018: Clean CORS — reject unknown origins, no localhost in production
const ALLOWED_ORIGINS = [
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
];

app.use('*', cors({
  origin: (origin) => {
    // Allow requests with no origin (server-to-server, mobile apps, curl)
    if (!origin) return '*';
    // Check against exact allowlist
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    // Reject unknown origins — don't leak a production origin in the response
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  maxAge: 86400,
  credentials: true,
}));

// Vary: Origin for proper CDN caching of CORS responses
app.use('*', async (c, next) => {
  await next();
  if (c.req.header('Origin')) {
    c.res.headers.set('Vary', 'Origin');
  }
});

// ── Rate Limiting (Durable Object backed) ────────────────
// Uses a Durable Object for shared state across all Worker requests.
// PP-SEC-019: Granular per-route rate limits.
const RATE_LIMITS: Record<string, number> = {
  'auth:login': 10,              // 10 login attempts/min
  'auth:signup': 3,              // 3 signups/min
  'auth:register': 5,            // 5 admin registrations/min
  'auth:forgot-password': 3,     // 3 reset requests/min
  'auth:reset-password': 3,      // 3 reset attempts/min
  'api:upload': 10,              // 10 uploads/min
  'api:write': 60,               // 60 writes/min
  'api:read': 300,               // 300 reads/min (was 1000)
};

// Rate limiting middleware — covers both /api/* and /auth/*
app.use('/api/*', rateLimitMiddleware);
app.use('/auth/*', rateLimitMiddleware);

// CSRF protection — validates X-CSRF-Token header on state-changing requests
// Middleware skips GET/HEAD/OPTIONS and non-browser API clients automatically
app.use('/api/*', csrfProtection);
app.use('/auth/*', csrfProtection);

async function rateLimitMiddleware(c: any, next: any) {
  const path = c.req.path;
  const method = c.req.method;
  
  let limitKey = 'api:read';
  if (path === '/auth/login' && method === 'POST') limitKey = 'auth:login';
  else if (path === '/auth/signup' && method === 'POST') limitKey = 'auth:signup';
  else if (path === '/auth/register' && method === 'POST') limitKey = 'auth:register';
  else if (path === '/auth/forgot-password' && method === 'POST') limitKey = 'auth:forgot-password';
  else if (path === '/auth/reset-password' && method === 'POST') limitKey = 'auth:reset-password';
  else if (path === '/api/images/upload' && method === 'POST') limitKey = 'api:upload';
  else if (['POST', 'PUT', 'DELETE'].includes(method)) limitKey = 'api:write';

  const limit = RATE_LIMITS[limitKey] || 200;
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  const key = `${limitKey}:${ip}`;

  // Get or create the RateLimiter Durable Object (idempotent by IP+key)
  const doId = c.env.RATE_LIMITER.idFromName(key);
  const stub = c.env.RATE_LIMITER.get(doId);
  
  // Call the DO to check the limit
  const result = await stub.checkLimit(key, limit);
  if (!result.allowed) {
    return c.json({
      success: false,
      message: `Too many requests. Please try again in ${result.retryAfter} seconds.`
    }, 429);
  }

  await next();
}

// ── Input Validation Helpers ──────────────────────────────
const MAX_STRING = 5000;
const MAX_ARRAY = 20;
const VALID_TYPES = ['rent', 'sale', 'land'];
const VALID_PROPERTY_TYPES = ['apartment', 'duplex', 'detached', 'terrace', 'villa', 'land', 'commercial', 'semi-detached'];
const VALID_SORT = ['price-asc', 'price-desc', 'newest', 'featured'];
const VALID_ROLES = ['admin', 'agent'];

function sanitizeString(v: unknown, maxLen = MAX_STRING): string {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

function sanitizeNumber(v: unknown, fallback = 0): number {
  const n = Number(v);
  return isNaN(n) || !isFinite(n) ? fallback : n;
}

function sanitizeEnum<T extends string>(v: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

// ── Health / Stats ────────────────────────────────────────
app.get('/api/stats', async (c) => {
  const db = c.env.DB;
  const [total, rent, sale, land, featured] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM listings').first<{c:number}>(),
    db.prepare("SELECT COUNT(*) as c FROM listings WHERE type='rent'").first<{c:number}>(),
    db.prepare("SELECT COUNT(*) as c FROM listings WHERE type='sale'").first<{c:number}>(),
    db.prepare("SELECT COUNT(*) as c FROM listings WHERE type='land'").first<{c:number}>(),
    db.prepare('SELECT COUNT(*) as c FROM listings WHERE featured=1').first<{c:number}>(),
  ]);
  return c.json({ success: true, data: { total: total?.c||0, rent: rent?.c||0, sale: sale?.c||0, land: land?.c||0, featured: featured?.c||0 } });
});

// ── Listings CRUD ─────────────────────────────────────────

// GET /api/listings
app.get('/api/listings', async (c) => {
  const db = c.env.DB;
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  const q = c.req.query();

  let sql = 'SELECT * FROM listings WHERE 1=1';
  const params: any[] = [];

  const type = sanitizeEnum(q.type, ['all', ...VALID_TYPES], 'all');
  if (type !== 'all') { sql += ' AND type = ?'; params.push(type); }
  if (q.city) { sql += ' AND city = ?'; params.push(sanitizeString(q.city, 100)); }
  if (q.area) { sql += ' AND area LIKE ?'; params.push(`%${sanitizeString(q.area, 100)}%`); }
  if (q.minPrice) { sql += ' AND price >= ?'; params.push(sanitizeNumber(q.minPrice)); }
  if (q.maxPrice) { sql += ' AND price <= ?'; params.push(sanitizeNumber(q.maxPrice)); }
  if (q.bedrooms) { sql += ' AND bedrooms >= ?'; params.push(sanitizeNumber(q.bedrooms)); }
  if (q.featured === 'true') { sql += ' AND featured = 1'; }
  if (q.verified === 'true') { sql += ' AND verified = 1'; }
  
  if (q.search) {
    const s = sanitizeString(q.search, 200);
    const like = `%${s}%`;
    sql += ' AND (title LIKE ? OR location LIKE ? OR area LIKE ? OR city LIKE ? OR description LIKE ?)';
    params.push(like, like, like, like, like);
  }

  // Sort — whitelist validated, no SQL injection
  const sort = sanitizeEnum(q.sort, VALID_SORT, 'featured');
  let orderClause = ' ORDER BY featured DESC, id DESC';
  if (sort === 'price-asc') orderClause = ' ORDER BY price ASC';
  else if (sort === 'price-desc') orderClause = ' ORDER BY price DESC';
  else if (sort === 'newest') orderClause = ' ORDER BY id DESC';

  // PP-SEC-026: Build WHERE clause separately — unordered COUNT, ordered data query
  const whereClause = sql.replace('SELECT * FROM listings WHERE 1=1', '');
  
  // PP-SEC-025 / PP-SEC-024: Mandatory pagination — cap at 100 items max, use sanitizePositiveInt
  const countResult = await db.prepare(`SELECT COUNT(*) as c FROM listings WHERE 1=1 ${whereClause}`).bind(...params).first<{c:number}>();
  const totalCount = countResult?.c || 0;

  const p = sanitizePositiveInt(q.page, 1, 1, 1000);
  const l = sanitizePositiveInt(q.limit, 20, 1, 100);
  const totalPages = Math.ceil(totalCount / l) || 1;
  const offset = (p - 1) * l;

  // PP-SEC-026: Separate ordered data query
  const { results } = await db.prepare(`SELECT * FROM listings WHERE 1=1 ${whereClause} ${orderClause} LIMIT ${l} OFFSET ${offset}`).bind(...params).all();
  const data = results.map(r => rowToListing(r));

  return c.json({ success: true, count: totalCount, page: p, limit: l, totalPages, hasNext: p < totalPages, hasPrev: p > 1, data });
});

app.get('/api/listings/:id', async (c) => {
  const id = sanitizeNumber(c.req.param('id'));
  if (id <= 0) return c.json({ success: false, message: 'Invalid ID' }, 400);
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  const row = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  if (!row) return c.json({ success: false, message: 'Listing not found' }, 404);
  return c.json({ success: true, data: rowToListing(row) });
});

app.post('/api/listings', requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid JSON' }, 400);

  // PP-SEC-023: Normalize all camelCase fields to snake_case before processing.
  // This ensures a single canonical field name regardless of what the client sends.
  const normalized: Record<string, any> = { ...body };

  const KNOWN_FIELDS = new Set([
    'title', 'type', 'property_type', 'propertyType', 'price', 'price_unit', 'priceUnit',
    'location', 'area', 'city', 'bedrooms', 'bathrooms', 'sqft', 'parking',
    'description', 'amenities', 'images', 'availability', 'featured', 'verified', 'badge',
    'agent_name', 'agent_role', 'agent_phone', 'agent_avatar',
    'agent', 'moveInCosts', 'annual_rent', 'agency_fee', 'security_deposit', 'service_charge',
  ]);

  // Warn about unknown/extra fields — they are stripped, not rejected
  const extraFields = Object.keys(body).filter(k => !KNOWN_FIELDS.has(k));
  if (extraFields.length > 0) {
    console.warn(`[PP-SEC-023] Unknown fields in POST /api/listings stripped: ${extraFields.join(', ')}`);
  }

  // Normalize camelCase -> snake_case for known dual-named fields
  if (body.propertyType !== undefined && body.property_type === undefined) normalized.property_type = body.propertyType;
  if (body.priceUnit !== undefined && body.price_unit === undefined) normalized.price_unit = body.priceUnit;
  if (body.moveInCosts) {
    if (body.moveInCosts.annualRent !== undefined && normalized.annual_rent === undefined) normalized.annual_rent = body.moveInCosts.annualRent;
    if (body.moveInCosts.agencyFee !== undefined && normalized.agency_fee === undefined) normalized.agency_fee = body.moveInCosts.agencyFee;
    if (body.moveInCosts.securityDeposit !== undefined && normalized.security_deposit === undefined) normalized.security_deposit = body.moveInCosts.securityDeposit;
    if (body.moveInCosts.serviceCharge !== undefined && normalized.service_charge === undefined) normalized.service_charge = body.moveInCosts.serviceCharge;
  }

  const title = sanitizeString(normalized.title, 200);
  const type = sanitizeEnum(normalized.type, VALID_TYPES, 'rent');
  const propertyType = sanitizeEnum(normalized.property_type, VALID_PROPERTY_TYPES, 'apartment');
  // PP-SEC-024: Sanitize price as positive int (Naira, no fractions)
  const price = sanitizePositiveInt(normalized.price, 0, 0, 100000000000);
  const priceUnit = sanitizeString(normalized.price_unit, 50) || (type === 'rent' ? '/ year' : '');
  const location = sanitizeString(normalized.location, 300);

  if (!title || !price || !location) {
    return c.json({ success: false, message: 'title, price, and location are required' }, 400);
  }

  const amenities = Array.isArray(normalized.amenities) ? normalized.amenities.slice(0, MAX_ARRAY).map((a: any) => sanitizeString(a, 200)) : [];
  const images = Array.isArray(normalized.images) ? normalized.images.slice(0, MAX_ARRAY).map((i: any) => sanitizeString(i, 1000)) : [];

  // PP-SEC-008: Agents cannot self-verify, self-feature, or impersonate other agents.
  // Admins can set trust/moderator fields; agents always get defaults derived from their user record.
  const isAdmin = user.role === 'admin';
  const featured = isAdmin ? (normalized.featured ? 1 : 0) : 0;
  const verified = isAdmin ? (normalized.verified ? 1 : 0) : 0;
  const badge = isAdmin ? sanitizeString(normalized.badge, 50) : '';
  const agentName = isAdmin ? sanitizeString(normalized.agent_name || normalized.agent?.name, 200) || user.name : user.name;
  const agentRole = isAdmin ? sanitizeString(normalized.agent_role || normalized.agent?.role, 200) : user.role;
  const agentPhone = isAdmin ? sanitizeString(normalized.agent_phone || normalized.agent?.phone, 50) : '';
  const agentAvatar = isAdmin ? sanitizeString(normalized.agent_avatar || normalized.agent?.avatar, 1000) : '';

  // PP-SEC-024: sanitizePositiveInt with domain-appropriate ranges
  const bedrooms = sanitizePositiveInt(normalized.bedrooms, 0, 0, 50);
  const bathrooms = sanitizePositiveInt(normalized.bathrooms, 0, 0, 50);
  const sqft = sanitizePositiveInt(normalized.sqft, 0, 0, 1000000);
  const parking = sanitizePositiveInt(normalized.parking, 0, 0, 100);
  const annualRent = normalized.annual_rent !== undefined ? sanitizePositiveInt(normalized.annual_rent, 0, 0, 100000000000) : null;
  const agencyFee = normalized.agency_fee !== undefined ? sanitizePositiveInt(normalized.agency_fee, 0, 0, 100000000000) : null;
  const securityDeposit = normalized.security_deposit !== undefined ? sanitizePositiveInt(normalized.security_deposit, 0, 0, 100000000000) : null;
  const serviceCharge = normalized.service_charge !== undefined ? sanitizePositiveInt(normalized.service_charge, 0, 0, 100000000000) : null;

  const result = await c.env.DB.prepare(`
    INSERT INTO listings (title, type, property_type, price, price_unit, location, area, city, bedrooms, bathrooms, sqft, parking, description, amenities, images, availability, featured, verified, badge, agent_name, agent_role, agent_phone, agent_avatar, annual_rent, agency_fee, security_deposit, service_charge, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    title, type, propertyType, price, priceUnit, location,
    sanitizeString(normalized.area, 100), sanitizeString(normalized.city, 100),
    bedrooms, bathrooms, sqft, parking,
    sanitizeString(normalized.description, 5000),
    JSON.stringify(amenities), JSON.stringify(images),
    sanitizeString(normalized.availability, 100) || 'Immediately',
    featured, verified, badge,
    agentName, agentRole, agentPhone, agentAvatar,
    annualRent, agencyFee, securityDeposit, serviceCharge,
    user.id
  ).run();

  const created = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(result.meta.last_row_id).first();
  return c.json({ success: true, data: rowToListing(created, isAdmin) }, 201);
});

app.put('/api/listings/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = sanitizeNumber(c.req.param('id'));
  if (id <= 0) return c.json({ success: false, message: 'Invalid ID' }, 400);

  const existing: any = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, message: 'Listing not found' }, 404);

  // Agents can only edit their own listings; admins can edit any
  if (user.role !== 'admin' && existing.created_by !== user.id) {
    return c.json({ success: false, message: 'You can only edit your own listings' }, 403);
  }

  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid JSON' }, 400);

  // PP-SEC-008: Role-specific update allowlists.
  // Agents can only update factual property content, NOT trust/moderation/identity fields.
  const isAdmin = user.role === 'admin';
  const updates: Record<string, any> = {};

  // Fields ALL users can update (factual property data)
  const commonStringFields: [string, number][] = [
    ['title', 200], ['price_unit', 50], ['location', 300], ['area', 100], ['city', 100],
    ['description', 5000], ['availability', 100],
  ];
  for (const [f, max] of commonStringFields) {
    if (body[f] !== undefined) updates[f] = sanitizeString(body[f], max);
  }

  // PP-SEC-024: Enforce VALID_TYPES / VALID_PROPERTY_TYPES enums on update.
  // Previously these passed through as arbitrary strings.
  if (body.type !== undefined) updates.type = sanitizeEnum(body.type, VALID_TYPES, existing.type);
  if (body.property_type !== undefined) updates.property_type = sanitizeEnum(body.property_type, VALID_PROPERTY_TYPES, existing.property_type);

  // Admin-only fields: trust badges, moderation status, agent identity overrides
  if (isAdmin) {
    const adminStringFields: [string, number][] = [
      ['badge', 50], ['agent_name', 200], ['agent_role', 200],
      ['agent_phone', 50], ['agent_avatar', 1000],
    ];
    for (const [f, max] of adminStringFields) {
      if (body[f] !== undefined) updates[f] = sanitizeString(body[f], max);
    }
    if (body.featured !== undefined) updates.featured = body.featured ? 1 : 0;
    if (body.verified !== undefined) updates.verified = body.verified ? 1 : 0;
  }

  // PP-SEC-024: Use sanitizePositiveInt with domain-appropriate ranges for all numeric fields
  const numFieldRanges: Record<string, [number, number]> = {
    price: [0, 100000000000],
    bedrooms: [0, 50],
    bathrooms: [0, 50],
    sqft: [0, 1000000],
    parking: [0, 100],
    annual_rent: [0, 100000000000],
    agency_fee: [0, 100000000000],
    security_deposit: [0, 100000000000],
    service_charge: [0, 100000000000],
  };
  for (const [f, [min, max]] of Object.entries(numFieldRanges)) {
    if (body[f] !== undefined) updates[f] = sanitizePositiveInt(body[f], 0, min, max);
  }
  if (body.amenities !== undefined) updates.amenities = JSON.stringify(
    (Array.isArray(body.amenities) ? body.amenities : []).slice(0, MAX_ARRAY).map((a: any) => sanitizeString(a, 200))
  );
  if (body.images !== undefined) updates.images = JSON.stringify(
    (Array.isArray(body.images) ? body.images : []).slice(0, MAX_ARRAY).map((i: any) => sanitizeString(i, 1000))
  );

  if (Object.keys(updates).length === 0) {
    return c.json({ success: false, message: 'No valid fields to update' }, 400);
  }

  const setClauses = Object.keys(updates).map(f => `${f} = ?`);
  const values = Object.values(updates);
  setClauses.push("updated_at = datetime('now')");

  await c.env.DB.prepare(`UPDATE listings SET ${setClauses.join(', ')} WHERE id = ?`).bind(...values, id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: rowToListing(updated, isAdmin) });
});

app.delete('/api/listings/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const id = sanitizeNumber(c.req.param('id'));
  if (id <= 0) return c.json({ success: false, message: 'Invalid ID' }, 400);
  const existing: any = await c.env.DB.prepare('SELECT id, created_by FROM listings WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, message: 'Listing not found' }, 404);
  if (user.role !== 'admin' && existing.created_by !== user.id) {
    return c.json({ success: false, message: 'You can only delete your own listings' }, 403);
  }
  await c.env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'Listing deleted' });
});

// ── Districts CRUD (admin only) ───────────────────────────
app.get('/api/districts', async (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  const { results } = await c.env.DB.prepare('SELECT * FROM districts ORDER BY id ASC').all();
  return c.json({ success: true, data: results.map((d: any) => ({ ...d, checks: safeJsonParse(d.checks, []) })) });
});

app.post('/api/districts', requireAuth, requireRole('admin'), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid JSON' }, 400);
  const name = sanitizeString(body.name, 200);
  const city = sanitizeString(body.city, 100);
  if (!name || !city) return c.json({ success: false, message: 'name and city required' }, 400);
  const checks = Array.isArray(body.checks) ? body.checks.slice(0, 10).map((c: any) => sanitizeString(c, 200)) : [];
  const result = await c.env.DB.prepare(
    'INSERT INTO districts (name, city, description, checks, image, link_type) VALUES (?,?,?,?,?,?)'
  ).bind(name, city, sanitizeString(body.description, 1000), JSON.stringify(checks), sanitizeString(body.image, 1000), sanitizeEnum(body.linkType || body.link_type, ['all','sale','rent','land'], 'all')).run();
  const created = await c.env.DB.prepare('SELECT * FROM districts WHERE id = ?').bind(result.meta.last_row_id).first();
  return c.json({ success: true, data: { ...(created as any), checks: safeJsonParse((created as any).checks, []) } }, 201);
});

app.put('/api/districts/:id', requireAuth, requireRole('admin'), async (c) => { /* similar pattern with validation */ 
  const id = sanitizeNumber(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid JSON' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM districts WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, message: 'District not found' }, 404);

  const updates: Record<string, any> = {};
  if (body.name !== undefined) updates.name = sanitizeString(body.name, 200);
  if (body.city !== undefined) updates.city = sanitizeString(body.city, 100);
  if (body.description !== undefined) updates.description = sanitizeString(body.description, 1000);
  if (body.image !== undefined) updates.image = sanitizeString(body.image, 1000);
  if (body.link_type !== undefined || body.linkType !== undefined) updates.link_type = sanitizeEnum(body.link_type || body.linkType, ['all','sale','rent','land'], 'all');
  if (body.checks !== undefined) updates.checks = JSON.stringify((Array.isArray(body.checks) ? body.checks : []).slice(0, 10).map((c: any) => sanitizeString(c, 200)));

  if (Object.keys(updates).length === 0) return c.json({ success: false, message: 'No valid fields' }, 400);
  const setClauses = Object.keys(updates).map(f => `${f} = ?`);
  await c.env.DB.prepare(`UPDATE districts SET ${setClauses.join(', ')} WHERE id = ?`).bind(...Object.values(updates), id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM districts WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: { ...(updated as any), checks: safeJsonParse((updated as any).checks, []) } });
});

app.delete('/api/districts/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = sanitizeNumber(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM districts WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'District deleted' });
});

// ── File Upload (single or multiple) ─────────────────────
// PP-SEC-015: Secure file upload with magic-byte validation, filename checks,
// per-user daily quotas, crypto-random keys, and safe content-type enforcement.
app.post('/api/images/upload', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  // ── Step 1: Extract files from form data ───────────────
  const formData = await c.req.raw.formData();
  const files: File[] = [];

  // Support both "file" (single) and "files" (multiple) field names
  for (const key of ['files', 'file']) {
    const entries = formData.getAll(key);
    for (const entry of entries) {
      if (entry && typeof entry === 'object' && 'name' in entry && 'size' in entry) files.push(entry as any);
    }
  }

  if (files.length === 0) {
    return c.json({ success: false, message: 'No file provided. Use "file" for single or "files" for multiple uploads.' }, 400);
  }

  // ── Step 2: File count limit ───────────────────────────
  if (files.length > MAX_FILES_PER_REQUEST) {
    return c.json({ success: false, message: `Too many files. Maximum ${MAX_FILES_PER_REQUEST} per request.` }, 400);
  }

  // ── Step 3: Per-user daily upload quota ────────────────
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  const dailyLog = await db.prepare(
    'SELECT count FROM upload_logs WHERE user_id = ? AND upload_date = ?'
  ).bind(user.id, today).first<{ count: number }>();
  const dailyCount = dailyLog?.count || 0;

  if (dailyCount >= MAX_UPLOADS_PER_USER_PER_DAY) {
    return c.json({ success: false, message: `Daily upload limit reached (${MAX_UPLOADS_PER_USER_PER_DAY}/day). Try again tomorrow.` }, 429);
  }

  const remainingQuota = MAX_UPLOADS_PER_USER_PER_DAY - dailyCount;
  if (files.length > remainingQuota) {
    return c.json({ success: false, message: `You have ${remainingQuota} upload(s) remaining today. Received ${files.length} file(s).` }, 400);
  }

  // ── Step 4: Process each file with full validation ─────
  const results: Array<{ key?: string; url?: string; type?: string; size?: number; name?: string; error?: string }> = [];
  let successfulUploads = 0;

  for (const file of files) {
    // --- 4a: Filename validation (double extensions, dangerous exts, traversal) ---
    const fnameResult = validateFilename(file.name);
    if (!fnameResult.valid) {
      results.push({ error: fnameResult.error, name: file.name });
      continue;
    }

    // --- 4b: Pre-filter MIME type (reject clearly invalid types early) ---
    if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
      results.push({ error: `Invalid content type: ${file.type}`, name: file.name });
      continue;
    }

    // --- 4c: Size check ---
    const isRisky = isRiskyType(file.type);
    const maxSize = isRisky ? MAX_RISKY_SIZE : MAX_IMAGE_SIZE;
    if (file.size > maxSize) {
      results.push({ error: `File too large: ${file.name} (max ${isRisky ? '50MB' : '10MB'})`, name: file.name });
      continue;
    }

    // --- 4d: Magic byte validation ---
    // Read first 512 bytes (enough for all supported magic signatures)
    let headerBytes: Uint8Array;
    try {
      const arrayBuffer = await file.slice(0, 512).arrayBuffer();
      headerBytes = new Uint8Array(arrayBuffer);
    } catch {
      results.push({ error: `Failed to read file: ${file.name}`, name: file.name });
      continue;
    }

    if (headerBytes.length < 4) {
      results.push({ error: `File too small to validate: ${file.name}`, name: file.name });
      continue;
    }

    const magicResult = detectFileType(headerBytes);
    if (!magicResult.valid || !magicResult.detectedType) {
      results.push({ error: `File signature not recognized: ${file.name} (claimed ${file.type})`, name: file.name });
      continue;
    }

    // The magic-bytes-detected type must be compatible with the claimed MIME type
    if (magicResult.detectedType !== file.type) {
      results.push({ error: `Content type mismatch: ${file.name} claims ${file.type} but is actually ${magicResult.detectedType}`, name: file.name });
      continue;
    }

    // --- 4e: Image-specific header integrity checks ---
    if (file.type.startsWith('image/')) {
      const imgHeaderResult = validateImageHeaders(headerBytes, file.type);
      if (!imgHeaderResult.valid) {
        results.push({ error: `${imgHeaderResult.error}: ${file.name}`, name: file.name });
        continue;
      }
    }

    // --- 4f: All checks passed — store in R2 with crypto-random key ---
    const folder = getR2FolderPrefix(file.type);
    const uuid = crypto.randomUUID();
    const ext = fnameResult.extension!;
    let key = `listings/${folder}/${uuid}.${ext}`;

    // PP-SEC-032: Never overwrite existing objects.
    // Collision with crypto.randomUUID() is astronomically unlikely,
    // but guard against it anyway by appending a suffix.
    let suffix = '';
    while (await c.env.IMAGES.head(key)) {
      suffix = `-${crypto.randomUUID().slice(0, 8)}`;
      key = `listings/${folder}/${uuid}${suffix}.${ext}`;
    }

    await c.env.IMAGES.put(key, file.stream() as any, {
      httpMetadata: { contentType: file.type }
    });

    // PP-SEC-030: Track ownership in DB for auditing and cleanup
    await db.prepare(
      'INSERT INTO upload_objects (user_id, object_key, original_name, content_type, size_bytes, folder) VALUES (?,?,?,?,?,?)'
    ).bind(user.id, key, file.name, file.type, file.size, folder).run();

    results.push({ key, url: `/api/images/${key}`, type: file.type, size: file.size, name: file.name });
    successfulUploads++;
  }

  // ── Step 5: Record daily upload count ──────────────────
  if (successfulUploads > 0) {
    await db.prepare(`
      INSERT INTO upload_logs (user_id, upload_date, count)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, upload_date) DO UPDATE SET
        count = count + ?,
        updated_at = datetime('now')
    `).bind(user.id, today, successfulUploads, successfulUploads).run();
  }

  return c.json({ success: true, data: results }, 201);
});

// ── File Retrieval ──────────────────────────────────────
// PP-SEC-015: Safe Content-Type whitelist (never trust user-supplied metadata).
// PP-SEC-031: Wildcard route to capture nested keys (e.g. listings/images/uuid.jpg).
// PP-SEC-032: Preserve R2 ETag, support If-None-Match, differentiated cache.
// Force Content-Disposition: attachment for PDFs/videos to prevent
// inline script execution and drive-by-downloads.
app.get('/api/images/*', async (c) => {
  // PP-SEC-031: Extract full key from path (handles nested keys with slashes)
  const key = c.req.path.replace('/api/images/', '');

  // Prevent directory traversal
  if (key.includes('..') || key.startsWith('/')) return c.notFound();

  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();

  // Extract extension from key for safe content-type lookup
  const dotIdx = key.lastIndexOf('.');
  const ext = dotIdx > -1 ? key.slice(dotIdx + 1).toLowerCase() : '';
  const safeContentType = getSafeContentType(ext);

  if (!safeContentType) {
    // Unknown extension — reject rather than serve with unknown type
    return c.json({ success: false, message: 'Unsupported file type' }, 415);
  }

  // PP-SEC-032: Support If-None-Match conditional requests using R2's ETag
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch && object.httpEtag && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304 });
  }

  const headers = new Headers();
  headers.set('Content-Type', safeContentType);

  // PP-SEC-032: Differentiated cache — immutable for images, short for PDFs/videos
  headers.set('Cache-Control', getCacheControl(ext));

  // PP-SEC-032: Preserve R2's ETag for conditional requests
  if (object.httpEtag) {
    headers.set('ETag', object.httpEtag);
  }

  // Force download for PDFs and videos (prevents inline script execution)
  if (requiresAttachmentDisposition(ext)) {
    const safeFilename = key.split('/').pop() || 'download';
    headers.set('Content-Disposition', `attachment; filename="${safeFilename}"`);
  }

  // Security headers
  headers.set('X-Content-Type-Options', 'nosniff');

  return new Response(object.body as any, { headers: headers as any });
});

// ── Upload Ownership Tracking (admin only) ──────────────
// PP-SEC-030: List and delete R2 uploads with ownership metadata.

// GET /api/uploads — list recent uploads with ownership info
app.get('/api/uploads', requireAuth, requireRole('admin'), async (c) => {
  const db = c.env.DB;
  const q = c.req.query();
  const p = Math.max(1, Math.floor(sanitizeNumber(q.page, 1)));
  const l = Math.max(1, Math.min(100, Math.floor(sanitizeNumber(q.limit, 20))));
  const offset = (p - 1) * l;

  const whereClauses: string[] = [];
  const params: any[] = [];

  if (q.user_id) {
    whereClauses.push('uo.user_id = ?');
    params.push(sanitizeNumber(q.user_id));
  }
  if (q.folder) {
    whereClauses.push('uo.folder = ?');
    params.push(sanitizeString(q.folder, 50));
  }
  if (q.content_type) {
    whereClauses.push('uo.content_type = ?');
    params.push(sanitizeString(q.content_type, 100));
  }

  const whereSQL = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

  const countResult = await db.prepare(
    `SELECT COUNT(*) as c FROM upload_objects uo ${whereSQL}`
  ).bind(...params).first<{c:number}>();
  const total = countResult?.c || 0;

  const { results } = await db.prepare(
    `SELECT uo.*, u.email as user_email, u.name as user_name
     FROM upload_objects uo
     LEFT JOIN users u ON uo.user_id = u.id
     ${whereSQL}
     ORDER BY uo.id DESC
     LIMIT ${l} OFFSET ${offset}`
  ).bind(...params).all();

  const totalPages = Math.ceil(total / l) || 1;

  return c.json({
    success: true,
    count: total,
    page: p,
    limit: l,
    totalPages,
    hasNext: p < totalPages,
    hasPrev: p > 1,
    data: results,
  });
});

// DELETE /api/uploads/:id — remove an R2 object and its DB record (admin only)
app.delete('/api/uploads/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = sanitizeNumber(c.req.param('id'));
  if (id <= 0) return c.json({ success: false, message: 'Invalid ID' }, 400);

  const record = await c.env.DB.prepare(
    'SELECT id, object_key FROM upload_objects WHERE id = ?'
  ).bind(id).first<{ id: number; object_key: string }>();

  if (!record) {
    return c.json({ success: false, message: 'Upload record not found' }, 404);
  }

  // Delete from R2 first, then from DB
  await c.env.IMAGES.delete(record.object_key);
  await c.env.DB.prepare('DELETE FROM upload_objects WHERE id = ?').bind(id).run();

  return c.json({
    success: true,
    message: `Upload ${id} (${record.object_key}) deleted`,
  });
});

// ── Cities CRUD ───────────────────────────────────────────
app.get('/api/cities', async (c) => {
  c.header('Cache-Control', 'public, max-age=3600');
  const { results } = await c.env.DB.prepare('SELECT * FROM cities ORDER BY name ASC').all();
  return c.json({ success: true, data: results });
});

app.post('/api/cities', requireAuth, requireRole('admin'), async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);
  const name = sanitizeString(body.name, 100);
  const state = sanitizeString(body.state, 100);
  if (!name) return c.json({ success: false, message: 'City name required' }, 400);
  // Check duplicate
  const exists = await c.env.DB.prepare('SELECT id FROM cities WHERE name = ?').bind(name).first();
  if (exists) return c.json({ success: false, message: 'City already exists' }, 409);
  const result = await c.env.DB.prepare('INSERT INTO cities (name, state) VALUES (?,?)').bind(name, state).run();
  const created = await c.env.DB.prepare('SELECT * FROM cities WHERE id = ?').bind(result.meta.last_row_id).first();
  return c.json({ success: true, data: created }, 201);
});

app.put('/api/cities/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = parseInt(c.req.param('id'));
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);
  const name = sanitizeString(body.name, 100);
  if (!name) return c.json({ success: false, message: 'City name required' }, 400);
  await c.env.DB.prepare('UPDATE cities SET name = ?, state = ? WHERE id = ?').bind(name, sanitizeString(body.state, 100), id).run();
  const updated = await c.env.DB.prepare('SELECT * FROM cities WHERE id = ?').bind(id).first();
  if (!updated) return c.json({ success: false, message: 'City not found' }, 404);
  return c.json({ success: true, data: updated });
});

app.delete('/api/cities/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = parseInt(c.req.param('id'));
  await c.env.DB.prepare('DELETE FROM cities WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'City deleted' });
});

// ── Auth Routes ───────────────────────────────────────────
app.route('/auth', authRoutes);

// ── Catch-all: 404 for unassigned API routes ─────────────
app.all('/api/*', (c) => {
  // PP-SEC-041: Generic error — don't leak internal route structure
  return c.json({
    success: false,
    message: 'Not found'
  }, 404);
});

// ── Catch-all: 404 for unknown non-API routes ────────────
// With run_worker_first = true, this only triggers for API/auth paths
// that don't match any defined route.
app.notFound((c) => {
  return c.json({ success: false, message: 'Not found' }, 404);
});

// ── Fetch Handler ─────────────────────────────────────────
// PP-SEC-010 / PP-SEC-011: Custom fetch handler that wraps the Hono app.
// HTML pages are intercepted, served from the ASSETS binding with per-request
// nonce injection and a strict Content-Security-Policy header.
// API routes are delegated to Hono. Static assets (CSS, JS, images, fonts)
// are served from ASSETS with security headers but no CSP.
export default {
  async fetch(request: Request, env: Bindings, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. API and auth routes — delegate to Hono
    if (path.startsWith('/api/') || path.startsWith('/auth/')) {
      return app.fetch(request, env, ctx);
    }

    // 2. HTML pages — fetch from ASSETS, inject nonces, set strict CSP
    if (isHtmlPath(path)) {
      return serveHtmlWithNonce(request, env, path);
    }

    // 3. Static assets (CSS, JS, images, fonts) — serve with basic headers
    try {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.ok) {
        const headers = new Headers(assetResponse.headers);
        // Prevent stale cached assets without proper CSP nonce
        headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
        setAssetSecurityHeaders(headers);
        return new Response(assetResponse.body, {
          status: assetResponse.status,
          statusText: assetResponse.statusText,
          headers,
        });
      }
    } catch (_e) {
      // ASSETS binding failed — fall through
    }

    // 4. Not found
    return new Response('Not Found', { status: 404 });
  },
};

export { RateLimiter };

// ── HTML Serving Helper ────────────────────────────────────

/**
 * Serves an HTML page from the ASSETS binding with per-request nonce injection
 * and strict Content-Security-Policy.
 *
 * Steps:
 *   1. Rewrite / to /index.html for ASSETS lookup
 *   2. Fetch the HTML from ASSETS
 *   3. Generate a fresh random nonce
 *   4. Inject nonce="..." into every <script> and <style> tag
 *   5. Set the strict CSP header referencing the nonce
 *   6. Set all other security headers (HSTS, X-Frame-Options, etc.)
 */
async function serveHtmlWithNonce(
  request: Request,
  env: Bindings,
  path: string,
): Promise<Response> {
  // Rewrite / to /index (Cloudflare clean URLs strip .html)
  let assetPath = path;
  if (assetPath === '/' || assetPath === '') {
    assetPath = '/index';  // Cloudflare serves index.html for /index path
  }

  const assetUrl = new URL(request.url);
  assetUrl.pathname = assetPath;
  const assetRequest = new Request(assetUrl.toString(), request);

  let assetResponse: Response;
  try {
    assetResponse = await env.ASSETS.fetch(assetRequest);
    
    // Follow redirects internally (Cloudflare strips .html → clean URL)
    // Don't return the redirect to the browser — that causes loops.
    if (assetResponse.status >= 300 && assetResponse.status < 400) {
      const location = assetResponse.headers.get('Location');
      if (location) {
        const redirectUrl = new URL(location, request.url);
        const redirectRequest = new Request(redirectUrl.toString(), request);
        assetResponse = await env.ASSETS.fetch(redirectRequest);
      }
    }
  } catch (_e) {
    return new Response('Not Found', { status: 404 });
  }

  if (!assetResponse.ok) {
    // Let 404s from ASSETS pass through as-is
    return assetResponse;
  }

  // Verify the response is actually HTML (guard against misconfigured routing)
  const contentType = assetResponse.headers.get('Content-Type') || '';
  if (!contentType.includes('text/html')) {
    // Not HTML — return as-is (shouldn't normally happen for .html paths)
    return assetResponse;
  }

  // Generate a fresh nonce and inject it into all script/style tags
  const nonce = generateNonce();
  const html = await assetResponse.text();
  const injectedHtml = injectNonces(html, nonce);

  // Build the response with the injected HTML
  const response = new Response(injectedHtml, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
  });

  // Copy over original headers except CSP (we set our own strict one)
  assetResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower !== 'content-security-policy' && lower !== 'content-security-policy-report-only') {
      response.headers.set(key, value);
    }
  });

  // Ensure correct Content-Type and set strict security headers
  response.headers.set('Content-Type', 'text/html; charset=utf-8');
  setHtmlSecurityHeaders(response.headers, nonce);

  return response;
}
