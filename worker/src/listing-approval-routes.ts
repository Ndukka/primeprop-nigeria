import { authRoutes, csrfProtection, requireAuth, requireRole } from './auth';
import { rowToListing, sanitizePositiveInt } from './utils';

const VALID_TYPES = ['rent', 'sale', 'land'] as const;
const VALID_SORT = ['price-asc', 'price-desc', 'newest', 'featured'] as const;

type ListingType = typeof VALID_TYPES[number];
type ListingSort = typeof VALID_SORT[number];

function sanitizeString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function approvedListingWhere(query: Record<string, string>) {
  const clauses = ["approval_status = 'approved'"];
  const parameters: unknown[] = [];

  const type = sanitizeEnum<ListingType | 'all'>(query.type, ['all', ...VALID_TYPES], 'all');
  if (type !== 'all') {
    clauses.push('type = ?');
    parameters.push(type);
  }
  if (query.city) {
    clauses.push('city = ?');
    parameters.push(sanitizeString(query.city, 100));
  }
  if (query.area) {
    clauses.push("instr(lower(COALESCE(area, '')), lower(?)) > 0");
    parameters.push(sanitizeString(query.area, 100));
  }
  if (query.minPrice) {
    clauses.push('price >= ?');
    parameters.push(sanitizePositiveInt(query.minPrice, 0, 0, 100000000000));
  }
  if (query.maxPrice) {
    clauses.push('price <= ?');
    parameters.push(sanitizePositiveInt(query.maxPrice, 100000000000, 0, 100000000000));
  }
  if (query.bedrooms) {
    clauses.push('bedrooms >= ?');
    parameters.push(sanitizePositiveInt(query.bedrooms, 0, 0, 50));
  }
  if (query.featured === 'true') clauses.push('featured = 1');
  if (query.verified === 'true') clauses.push('verified = 1');

  if (query.search) {
    const search = sanitizeString(query.search, 200);
    clauses.push(
      "(instr(lower(COALESCE(title, '')), lower(?)) > 0"
      + " OR instr(lower(COALESCE(location, '')), lower(?)) > 0"
      + " OR instr(lower(COALESCE(area, '')), lower(?)) > 0"
      + " OR instr(lower(COALESCE(city, '')), lower(?)) > 0"
      + " OR instr(lower(COALESCE(description, '')), lower(?)) > 0)",
    );
    parameters.push(search, search, search, search, search);
  }

  return {
    sql: `WHERE ${clauses.join(' AND ')}`,
    parameters,
  };
}

function listingOrder(value: unknown): string {
  const sort = sanitizeEnum<ListingSort>(value, VALID_SORT, 'featured');
  if (sort === 'price-asc') return 'ORDER BY price ASC';
  if (sort === 'price-desc') return 'ORDER BY price DESC';
  if (sort === 'newest') return 'ORDER BY id DESC';
  return 'ORDER BY featured DESC, id DESC';
}

// These routes are the single public catalogue boundary. production-entry.ts
// rewrites the legacy /api/listings and /api/stats paths here so pending rows
// cannot leak through an older handler.
authRoutes.get('/public-listings', async c => {
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  const query = c.req.query();
  const page = sanitizePositiveInt(query.page, 1, 1, 1000);
  const limit = sanitizePositiveInt(query.limit, 20, 1, 100);
  const offset = (page - 1) * limit;
  const where = approvedListingWhere(query);

  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS c FROM listings ${where.sql}`,
  ).bind(...where.parameters).first<{ c: number }>();
  const total = count?.c || 0;
  const totalPages = Math.ceil(total / limit) || 1;

  const result = await c.env.DB.prepare(
    `SELECT * FROM listings ${where.sql} ${listingOrder(query.sort)} LIMIT ${limit} OFFSET ${offset}`,
  ).bind(...where.parameters).all();

  return c.json({
    success: true,
    count: total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    data: (result.results || []).map(row => rowToListing(row)),
  });
});

authRoutes.get('/public-listings/:id', async c => {
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid ID' }, 400);

  const listing = await c.env.DB.prepare(
    "SELECT * FROM listings WHERE id = ? AND approval_status = 'approved'",
  ).bind(id).first();
  if (!listing) return c.json({ success: false, message: 'Listing not found' }, 404);
  return c.json({ success: true, data: rowToListing(listing) });
});

authRoutes.get('/public-listing-stats', async c => {
  c.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  const db = c.env.DB;
  const approved = "approval_status = 'approved'";
  const [total, rent, sale, land, featured] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${approved}`).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${approved} AND type = 'rent'`).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${approved} AND type = 'sale'`).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${approved} AND type = 'land'`).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) AS c FROM listings WHERE ${approved} AND featured = 1`).first<{ c: number }>(),
  ]);

  return c.json({
    success: true,
    data: {
      total: total?.c || 0,
      rent: rent?.c || 0,
      sale: sale?.c || 0,
      land: land?.c || 0,
      featured: featured?.c || 0,
    },
  });
});

authRoutes.put(
  '/admin-listings/:id/approval',
  csrfProtection,
  requireAuth,
  requireRole('admin'),
  async c => {
    c.header('Cache-Control', 'no-store');
    const user = c.get('user');
    const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return c.json({ success: false, message: 'Invalid listing ID' }, 400);

    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    const approvalStatus = body?.approvalStatus ?? body?.approval_status;
    if (approvalStatus !== 'approved' && approvalStatus !== 'pending') {
      return c.json({ success: false, message: 'Approval status must be approved or pending' }, 400);
    }

    const existing = await c.env.DB.prepare('SELECT id FROM listings WHERE id = ?').bind(id).first();
    if (!existing) return c.json({ success: false, message: 'Listing not found' }, 404);

    if (approvalStatus === 'approved') {
      await c.env.DB.prepare(
        `UPDATE listings
         SET approval_status = 'approved',
             approved_by = ?,
             approved_at = datetime('now')
         WHERE id = ?`,
      ).bind(user.id, id).run();
    } else {
      await c.env.DB.prepare(
        `UPDATE listings
         SET approval_status = 'pending',
             approved_by = NULL,
             approved_at = NULL
         WHERE id = ?`,
      ).bind(id).run();
    }

    const updated = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
    return c.json({
      success: true,
      message: approvalStatus === 'approved'
        ? 'Listing approved and published.'
        : 'Listing removed from the public catalogue.',
      data: rowToListing(updated, true),
    });
  },
);
