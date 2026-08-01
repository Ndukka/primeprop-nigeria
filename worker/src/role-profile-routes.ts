import { authRoutes, csrfProtection, requireAuth, requireRole } from './auth';
import { rowToListing, sanitizePositiveInt } from './utils';

const MAX_ARRAY = 20;
const VALID_TYPES = ['rent', 'sale', 'land'] as const;
const VALID_PROPERTY_TYPES = [
  'apartment',
  'service-apartment',
  'duplex',
  'detached',
  'semi-detached',
  'terrace',
  'villa',
  'land',
  'commercial',
] as const;

type ListingType = typeof VALID_TYPES[number];
type PropertyType = typeof VALID_PROPERTY_TYPES[number];

type UserProfileRow = {
  id: number;
  email: string;
  name: string;
  role: string;
  phone: string | null;
  avatar_url: string | null;
  agent_title: string | null;
  account_status: string;
};

function sanitizeString(value: unknown, maxLength = 5000): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function sanitizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? value as T : fallback;
}

function normalizeListingBody(body: Record<string, any>): Record<string, any> {
  const normalized = { ...body };
  if (body.propertyType !== undefined && body.property_type === undefined) {
    normalized.property_type = body.propertyType;
  }
  if (body.priceUnit !== undefined && body.price_unit === undefined) {
    normalized.price_unit = body.priceUnit;
  }
  if (body.moveInCosts) {
    if (body.moveInCosts.annualRent !== undefined && normalized.annual_rent === undefined) {
      normalized.annual_rent = body.moveInCosts.annualRent;
    }
    if (body.moveInCosts.agencyFee !== undefined && normalized.agency_fee === undefined) {
      normalized.agency_fee = body.moveInCosts.agencyFee;
    }
    if (body.moveInCosts.securityDeposit !== undefined && normalized.security_deposit === undefined) {
      normalized.security_deposit = body.moveInCosts.securityDeposit;
    }
    if (body.moveInCosts.serviceCharge !== undefined && normalized.service_charge === undefined) {
      normalized.service_charge = body.moveInCosts.serviceCharge;
    }
  }
  return normalized;
}

function cleanStringArray(value: unknown, itemLength: number): string[] {
  return (Array.isArray(value) ? value : [])
    .slice(0, MAX_ARRAY)
    .map(item => sanitizeString(item, itemLength))
    .filter(Boolean);
}

async function profileForUser(c: any, userId: number): Promise<UserProfileRow | null> {
  return c.env.DB.prepare(
    `SELECT id, email, name, role, phone, avatar_url, agent_title, account_status
     FROM users WHERE id = ?`
  ).bind(userId).first<UserProfileRow>();
}

function publicProfile(profile: UserProfileRow) {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name || '',
    role: profile.role,
    phone: profile.phone || '',
    avatar_url: profile.avatar_url || '',
    agent_title: profile.agent_title || 'Listing Agent',
    account_status: profile.account_status,
  };
}

// GET /auth/profile-settings — account-owned listing identity defaults.
authRoutes.get('/profile-settings', requireAuth, async (c) => {
  c.header('Cache-Control', 'no-store');
  const user = c.get('user');
  const profile = await profileForUser(c, user.id);
  if (!profile) return c.json({ success: false, message: 'Profile not found' }, 404);
  return c.json({ success: true, data: publicProfile(profile) });
});

// PUT /auth/profile-settings — users may edit only their own public profile.
authRoutes.put('/profile-settings', csrfProtection, requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null) as Record<string, any> | null;
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);

  const updates: Record<string, string> = {};
  if (body.name !== undefined) {
    const name = sanitizeString(body.name, 200);
    if (!name) return c.json({ success: false, message: 'Name is required' }, 400);
    updates.name = name;
  }
  if (body.phone !== undefined) updates.phone = sanitizeString(body.phone, 50);
  if (body.agent_title !== undefined) {
    updates.agent_title = sanitizeString(body.agent_title, 120) || 'Listing Agent';
  }
  if (body.avatar_url !== undefined) {
    const avatar = sanitizeString(body.avatar_url, 1000);
    if (avatar && !avatar.startsWith('https://') && !avatar.startsWith('/api/images/')) {
      return c.json({ success: false, message: 'Profile picture must use HTTPS or an uploaded PrimeProp image' }, 400);
    }
    updates.avatar_url = avatar;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ success: false, message: 'No editable profile fields were supplied' }, 400);
  }

  const clauses = Object.keys(updates).map(field => `${field} = ?`);
  await c.env.DB.prepare(
    `UPDATE users SET ${clauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`
  ).bind(...Object.values(updates), user.id).run();

  const profile = await profileForUser(c, user.id);
  if (!profile) return c.json({ success: false, message: 'Profile not found after update' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, message: 'Profile updated', data: publicProfile(profile) });
});

// GET /auth/admin-listings — uncached full DTO for the administrator table.
authRoutes.get('/admin-listings', requireAuth, requireRole('admin'), async (c) => {
  c.header('Cache-Control', 'no-store');
  const query = c.req.query();
  const page = sanitizePositiveInt(query.page, 1, 1, 1000);
  const limit = sanitizePositiveInt(query.limit, 100, 1, 100);
  const offset = (page - 1) * limit;
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM listings').first<{ c: number }>();
  const total = count?.c || 0;
  const totalPages = Math.ceil(total / limit) || 1;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM listings ORDER BY featured DESC, id DESC LIMIT ${limit} OFFSET ${offset}`
  ).all();

  return c.json({
    success: true,
    count: total,
    page,
    limit,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    data: results.map(row => rowToListing(row, true)),
  });
});

// POST /auth/listing-records — role-aware browser listing creation.
authRoutes.post('/listing-records', csrfProtection, requireAuth, async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null) as Record<string, any> | null;
  if (!body) return c.json({ success: false, message: 'Invalid JSON' }, 400);

  const profile = await profileForUser(c, user.id);
  if (!profile || profile.account_status !== 'active') {
    return c.json({ success: false, message: 'Active profile required' }, 403);
  }

  const normalized = normalizeListingBody(body);
  const title = sanitizeString(normalized.title, 200);
  const type = sanitizeEnum<ListingType>(normalized.type, VALID_TYPES, 'rent');
  const propertyType = sanitizeEnum<PropertyType>(normalized.property_type, VALID_PROPERTY_TYPES, 'apartment');
  const price = sanitizePositiveInt(normalized.price, 0, 0, 100000000000);
  const priceUnit = sanitizeString(normalized.price_unit, 50) || (type === 'rent' ? '/ year' : '');
  const location = sanitizeString(normalized.location, 300);

  if (!title || !price || !location) {
    return c.json({ success: false, message: 'title, price, and location are required' }, 400);
  }

  const isAdmin = user.role === 'admin';
  const profileTitle = sanitizeString(profile.agent_title, 120) || 'Listing Agent';
  const featured = isAdmin && normalized.featured ? 1 : 0;
  const verified = isAdmin && normalized.verified ? 1 : 0;
  const badge = isAdmin ? sanitizeString(normalized.badge, 50) : '';
  const agentName = isAdmin
    ? sanitizeString(normalized.agent_name || normalized.agent?.name, 200) || profile.name
    : profile.name;
  const agentRole = isAdmin
    ? sanitizeString(normalized.agent_role || normalized.agent?.role, 120) || profileTitle
    : profileTitle;
  const agentPhone = isAdmin
    ? sanitizeString(normalized.agent_phone || normalized.agent?.phone, 50) || profile.phone || ''
    : profile.phone || '';
  const agentAvatar = isAdmin
    ? sanitizeString(normalized.agent_avatar || normalized.agent?.avatar, 1000) || profile.avatar_url || ''
    : profile.avatar_url || '';

  const result = await c.env.DB.prepare(`
    INSERT INTO listings (
      title, type, property_type, price, price_unit, location, area, city,
      bedrooms, bathrooms, sqft, parking, description, amenities, images,
      availability, featured, verified, badge, agent_name, agent_role,
      agent_phone, agent_avatar, annual_rent, agency_fee, security_deposit,
      service_charge, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    title,
    type,
    propertyType,
    price,
    priceUnit,
    location,
    sanitizeString(normalized.area, 100),
    sanitizeString(normalized.city, 100),
    sanitizePositiveInt(normalized.bedrooms, 0, 0, 50),
    sanitizePositiveInt(normalized.bathrooms, 0, 0, 50),
    sanitizePositiveInt(normalized.sqft, 0, 0, 1000000),
    sanitizePositiveInt(normalized.parking, 0, 0, 100),
    sanitizeString(normalized.description, 5000),
    JSON.stringify(cleanStringArray(normalized.amenities, 200)),
    JSON.stringify(cleanStringArray(normalized.images, 1000)),
    sanitizeString(normalized.availability, 100) || 'Immediately',
    featured,
    verified,
    badge,
    agentName,
    agentRole,
    agentPhone,
    agentAvatar,
    normalized.annual_rent !== undefined ? sanitizePositiveInt(normalized.annual_rent, 0, 0, 100000000000) : null,
    normalized.agency_fee !== undefined ? sanitizePositiveInt(normalized.agency_fee, 0, 0, 100000000000) : null,
    normalized.security_deposit !== undefined ? sanitizePositiveInt(normalized.security_deposit, 0, 0, 100000000000) : null,
    normalized.service_charge !== undefined ? sanitizePositiveInt(normalized.service_charge, 0, 0, 100000000000) : null,
    user.id,
  ).run();

  const created = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?')
    .bind(result.meta.last_row_id).first();
  return c.json({ success: true, data: rowToListing(created, isAdmin) }, 201);
});

// PUT /auth/listing-records/:id — factual fields for owners, moderation for admins.
authRoutes.put('/listing-records/:id', csrfProtection, requireAuth, async (c) => {
  const user = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 0, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid listing ID' }, 400);

  const existing = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first<any>();
  if (!existing) return c.json({ success: false, message: 'Listing not found' }, 404);
  if (user.role !== 'admin' && existing.created_by !== user.id) {
    return c.json({ success: false, message: 'You can only edit your own listings' }, 403);
  }

  const body = await c.req.json().catch(() => null) as Record<string, any> | null;
  if (!body) return c.json({ success: false, message: 'Invalid JSON' }, 400);
  const normalized = normalizeListingBody(body);
  const isAdmin = user.role === 'admin';
  const updates: Record<string, any> = {};

  const stringFields: Array<[string, number]> = [
    ['title', 200], ['price_unit', 50], ['location', 300], ['area', 100],
    ['city', 100], ['description', 5000], ['availability', 100],
  ];
  for (const [field, maxLength] of stringFields) {
    if (normalized[field] !== undefined) updates[field] = sanitizeString(normalized[field], maxLength);
  }

  if (normalized.type !== undefined) {
    updates.type = sanitizeEnum<ListingType>(normalized.type, VALID_TYPES, existing.type as ListingType);
  }
  if (normalized.property_type !== undefined) {
    updates.property_type = sanitizeEnum<PropertyType>(
      normalized.property_type,
      VALID_PROPERTY_TYPES,
      existing.property_type as PropertyType,
    );
  }

  const numericFields: Record<string, [number, number]> = {
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
  for (const [field, [minimum, maximum]] of Object.entries(numericFields)) {
    if (normalized[field] !== undefined) {
      updates[field] = sanitizePositiveInt(normalized[field], 0, minimum, maximum);
    }
  }

  if (normalized.amenities !== undefined) {
    updates.amenities = JSON.stringify(cleanStringArray(normalized.amenities, 200));
  }
  if (normalized.images !== undefined) {
    updates.images = JSON.stringify(cleanStringArray(normalized.images, 1000));
  }

  // Only administrators may change trust/moderation or listing identity fields.
  if (isAdmin) {
    const adminStrings: Array<[string, number]> = [
      ['badge', 50], ['agent_name', 200], ['agent_role', 120],
      ['agent_phone', 50], ['agent_avatar', 1000],
    ];
    for (const [field, maxLength] of adminStrings) {
      if (normalized[field] !== undefined) updates[field] = sanitizeString(normalized[field], maxLength);
    }
    if (normalized.featured !== undefined) updates.featured = normalized.featured ? 1 : 0;
    if (normalized.verified !== undefined) updates.verified = normalized.verified ? 1 : 0;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ success: false, message: 'No editable listing fields were supplied' }, 400);
  }

  const clauses = Object.keys(updates).map(field => `${field} = ?`);
  clauses.push("updated_at = datetime('now')");
  await c.env.DB.prepare(`UPDATE listings SET ${clauses.join(', ')} WHERE id = ?`)
    .bind(...Object.values(updates), id).run();

  const updated = await c.env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first();
  return c.json({ success: true, data: rowToListing(updated, isAdmin) });
});
