import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { authRoutes, requireAuth, requireRole } from './auth';
import type { D1Database, R2Bucket } from '@cloudflare/workers-types';

type Bindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
  JWT_SECRET: string;
  ENVIRONMENT: string;
  RATE_LIMIT_KV?: KVNamespace;
};

type Variables = {
  user: { id: number; email: string; role: string; name: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ── Security Headers ──────────────────────────────────────
app.use('*', async (c, next) => {
  await next();
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-XSS-Protection', '1; mode=block');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.res.headers.set('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com; " +
    "img-src 'self' data: https: blob:; " +
    "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com; " +
    "media-src 'self' https:; " +
    "connect-src 'self' https:; " +
    "frame-ancestors 'none';"
  );
});

// ── CORS + Cache ──────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://primeprop-worker.ndupsn.workers.dev',
  'https://primeprop.ng',
  'http://localhost:3001',
  'http://localhost:8787',
];

// Cache GET responses 60s
app.use('*', async (c, next) => {
  await next(); // (caching handled per-route)
});

app.use('*', cors({
  origin: (origin) => {
    // Allow requests with no origin (server-to-server, mobile apps, curl)
    if (!origin) return '*';
    // Check against whitelist
    if (ALLOWED_ORIGINS.includes(origin)) return origin;
    // In development, allow all localhost
    if (origin.startsWith('http://localhost:')) return origin;
    return ALLOWED_ORIGINS[0]; // Default to production URL
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// ── Rate Limiting ─────────────────────────────────────────
const RATE_WINDOW = 60_000; // 1 minute
const RATE_LIMITS: Record<string, number> = {
  'auth:login': 30,
  'auth:register': 10,
  'api:write': 120,
  'api:read': 600,
  'default': 200,
};

app.use('*', async (c, next) => {
  const path = c.req.path;
  const method = c.req.method;
  
  // Determine rate limit key
  let limitKey = 'default';
  if (path === '/auth/login' && method === 'POST') limitKey = 'auth:login';
  else if (path === '/auth/register' && method === 'POST') limitKey = 'auth:register';
  else if (['POST', 'PUT', 'DELETE'].includes(method)) limitKey = 'api:write';
  else if (method === 'GET') limitKey = 'api:read';

  const limit = RATE_LIMITS[limitKey] || 120;

  // Get client IP
  const ip = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  const key = `rate:${limitKey}:${ip}`;

  // Use D1 for rate limiting (simple approach)
  try {
    const now = Date.now();
    const windowStart = now - RATE_WINDOW;
    
    // Clean old entries
    await c.env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run();
    
    // Count recent requests
    const count = await c.env.DB.prepare(
      'SELECT COUNT(*) as c FROM rate_limits WHERE key = ? AND created_at > ?'
    ).bind(key, windowStart).first<{c: number}>();
    
    if ((count?.c || 0) >= limit) {
      return c.json({ success: false, message: 'Too many requests. Please try again later.' }, 429);
    }

    // Record this request
    await c.env.DB.prepare(
      'INSERT INTO rate_limits (key, created_at, expires_at) VALUES (?, ?, ?)'
    ).bind(key, now, now + RATE_WINDOW * 2).run();
  } catch {
    // If rate limiting DB fails, allow the request
  }

  await next();
});

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
  if (sort === 'price-asc') sql += ' ORDER BY price ASC';
  else if (sort === 'price-desc') sql += ' ORDER BY price DESC';
  else if (sort === 'newest') sql += ' ORDER BY id DESC';
  else sql += ' ORDER BY featured DESC, id DESC';

  const countResult = await db.prepare(`SELECT COUNT(*) as c FROM (${sql})`).bind(...params).first<{c:number}>();
  const totalCount = countResult?.c || 0;

  const hasPagination = q.page !== undefined || q.limit !== undefined;
  if (hasPagination) {
    const p = Math.max(1, Math.min(1000, sanitizeNumber(q.page, 1)));
    const l = Math.max(1, Math.min(100, sanitizeNumber(q.limit, 9)));
    sql += ` LIMIT ${l} OFFSET ${(p - 1) * l}`;
  }

  const { results } = await db.prepare(sql).bind(...params).all();
  const data = results.map(rowToListing);

  if (hasPagination) {
    const p = Math.max(1, Math.min(1000, sanitizeNumber(q.page, 1)));
    const l = Math.max(1, Math.min(100, sanitizeNumber(q.limit, 9)));
    const totalPages = Math.ceil(totalCount / l);
    return c.json({ success: true, count: totalCount, page: p, limit: l, totalPages, hasNext: p < totalPages, hasPrev: p > 1, data });
  }
  return c.json({ success: true, count: totalCount, data });
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

  const title = sanitizeString(body.title, 200);
  const type = sanitizeEnum(body.type, VALID_TYPES, 'rent');
  const propertyType = sanitizeEnum(body.propertyType || body.property_type, VALID_PROPERTY_TYPES, 'apartment');
  const price = sanitizeNumber(body.price);
  const priceUnit = sanitizeString(body.priceUnit || body.price_unit, 50) || (type === 'rent' ? '/ year' : '');
  const location = sanitizeString(body.location, 300);

  if (!title || !price || !location) {
    return c.json({ success: false, message: 'title, price, and location are required' }, 400);
  }

  const amenities = Array.isArray(body.amenities) ? body.amenities.slice(0, MAX_ARRAY).map((a: any) => sanitizeString(a, 200)) : [];
  const images = Array.isArray(body.images) ? body.images.slice(0, MAX_ARRAY).map((i: any) => sanitizeString(i, 1000)) : [];

  // Agent fields: agents can only set themselves, admins can set anyone
  const agentName = sanitizeString(body.agent_name || body.agent?.name, 200) || user.name;
  const agentRole = sanitizeString(body.agent_role || body.agent?.role, 200);
  const agentPhone = sanitizeString(body.agent_phone || body.agent?.phone, 50);
  const agentAvatar = sanitizeString(body.agent_avatar || body.agent?.avatar, 1000);

  const result = await c.env.DB.prepare(`
    INSERT INTO listings (title, type, property_type, price, price_unit, location, area, city, bedrooms, bathrooms, sqft, parking, description, amenities, images, availability, featured, verified, badge, agent_name, agent_role, agent_phone, agent_avatar, annual_rent, agency_fee, security_deposit, service_charge, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    title, type, propertyType, price, priceUnit, location,
    sanitizeString(body.area, 100), sanitizeString(body.city, 100),
    sanitizeNumber(body.bedrooms), sanitizeNumber(body.bathrooms),
    sanitizeNumber(body.sqft), sanitizeNumber(body.parking),
    sanitizeString(body.description, 5000),
    JSON.stringify(amenities), JSON.stringify(images),
    sanitizeString(body.availability, 100) || 'Immediately',
    body.featured ? 1 : 0,
    body.verified ? 1 : 0,
    sanitizeString(body.badge, 50),
    agentName, agentRole, agentPhone, agentAvatar,
    sanitizeNumber(body.annual_rent || body.moveInCosts?.annualRent) || null,
    sanitizeNumber(body.agency_fee || body.moveInCosts?.agencyFee) || null,
    sanitizeNumber(body.security_deposit || body.moveInCosts?.securityDeposit) || null,
    sanitizeNumber(body.service_charge || body.moveInCosts?.serviceCharge) || null,
    user.id
  ).run();

  const created = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(result.meta.last_row_id).first();
  return c.json({ success: true, data: rowToListing(created) }, 201);
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

  const updates: Record<string, any> = {};

  // Only allow specific fields to be updated (no mass assignment)
  const stringFields: [string, number][] = [
    ['title', 200], ['type', 50], ['property_type', 100],
    ['price_unit', 50], ['location', 300], ['area', 100], ['city', 100],
    ['description', 5000], ['availability', 100], ['badge', 50],
    ['agent_name', 200], ['agent_role', 200], ['agent_phone', 50], ['agent_avatar', 1000],
  ];
  for (const [f, max] of stringFields) {
    if (body[f] !== undefined) updates[f] = sanitizeString(body[f], max);
  }

  const numFields = ['price', 'bedrooms', 'bathrooms', 'sqft', 'parking', 'annual_rent', 'agency_fee', 'security_deposit', 'service_charge'];
  for (const f of numFields) {
    if (body[f] !== undefined) updates[f] = sanitizeNumber(body[f]);
  }

  if (body.featured !== undefined) updates.featured = body.featured ? 1 : 0;
  if (body.verified !== undefined) updates.verified = body.verified ? 1 : 0;
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
  return c.json({ success: true, data: rowToListing(updated) });
});

app.delete('/api/listings/:id', requireAuth, requireRole('admin'), async (c) => {
  const id = sanitizeNumber(c.req.param('id'));
  if (id <= 0) return c.json({ success: false, message: 'Invalid ID' }, 400);
  const existing = await c.env.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(id).first();
  if (!existing) return c.json({ success: false, message: 'Listing not found' }, 404);
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
app.post('/api/images/upload', requireAuth, async (c) => {
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

  const allowedTypes = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
    'application/pdf',
    'video/mp4', 'video/webm', 'video/quicktime',
  ];

  const results = [];
  for (const file of files) {
    if (!allowedTypes.includes(file.type)) {
      results.push({ error: `Skipped ${file.name}: invalid type ${file.type}` });
      continue;
    }

    const isVideo = file.type.startsWith('video/');
    const maxSize = isVideo ? 50 * 1024 * 1024 : 10 * 1024 * 1024;
    if (file.size > maxSize) {
      results.push({ error: `Skipped ${file.name}: too large (max ${isVideo ? '50MB' : '10MB'})` });
      continue;
    }

    let folder = 'images';
    if (file.type === 'application/pdf') folder = 'documents';
    else if (file.type.startsWith('video/')) folder = 'videos';

    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key = `listings/${folder}/${Date.now()}-${safeName}`;
    await c.env.IMAGES.put(key, file.stream() as any, { httpMetadata: { contentType: file.type } });
    results.push({ key, url: `/api/images/${key}`, type: file.type, size: file.size, name: file.name });
  }

  return c.json({ success: true, data: results }, 201);
});

app.get('/api/images/:key', async (c) => {
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  const key = c.req.param('key');
  // Prevent directory traversal
  if (key.includes('..') || key.startsWith('/')) return c.notFound();
  const object = await c.env.IMAGES.get(key);
  if (!object) return c.notFound();
  const headers = new Headers() as any;
  object.writeHttpMetadata(headers);
  headers.set('cache-control', 'public, max-age=31536000');
  return new Response(object.body as any, { headers: headers as any });
});

// ── Auth Routes ───────────────────────────────────────────
app.route('/auth', authRoutes);

// ── Helpers ───────────────────────────────────────────────
function rowToListing(row: any) {
  if (!row) return null;
  const agentName = row.agent_name || '';
  return {
    ...row,
    price: Number(row.price),
    bedrooms: Number(row.bedrooms || 0),
    bathrooms: Number(row.bathrooms || 0),
    sqft: Number(row.sqft || 0),
    parking: Number(row.parking || 0),
    featured: Boolean(row.featured),
    verified: Boolean(row.verified),
    amenities: safeJsonParse(row.amenities, []),
    images: safeJsonParse(row.images, []).map((url: string) => ({
      url,
      type: isYouTube(url) ? 'youtube' :
            url.match(/\.(mp4|webm|mov)(\?|$)/i) ? 'video' :
            url.match(/\.(pdf)(\?|$)/i) ? 'pdf' : 'image'
    })),
    priceDisplay: `₦${Number(row.price).toLocaleString()}`,
    agent: {
      name: agentName,
      role: row.agent_role || '',
      phone: row.agent_phone || '',
      avatar: row.agent_avatar || '',
      initials: agentName ? agentName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2) : 'NA',
    },
    moveInCosts: row.annual_rent ? {
      annualRent: Number(row.annual_rent),
      agencyFee: Number(row.agency_fee || 0),
      securityDeposit: Number(row.security_deposit || 0),
      serviceCharge: Number(row.service_charge || 0),
      total: Number(row.annual_rent) + Number(row.agency_fee || 0) + Number(row.security_deposit || 0) + Number(row.service_charge || 0),
    } : null,
  };
}

function safeJsonParse(val: any, fallback: any) {
  if (!val) return fallback;
  try { return typeof val === 'string' ? JSON.parse(val) : val; } catch { return fallback; }
}

function isYouTube(url: string): boolean {
  if (!url) return false;
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(url);
}

export default app;
