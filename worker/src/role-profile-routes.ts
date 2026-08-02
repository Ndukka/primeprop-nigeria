import { authRoutes, csrfProtection, requireAuth, requireRole } from './auth';
import { rowToListing, sanitizePositiveInt, safeJsonParse } from './utils';

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
  bio: string | null;
  organization_name: string | null;
  organization_role: string | null;
  organization_website: string | null;
  organization_address: string | null;
  organization_logo_url: string | null;
  public_email: string | null;
  website_url: string | null;
  service_areas: string | null;
  specialties: string | null;
  languages: string | null;
  professional_memberships: string | null;
  years_experience: number | null;
  license_body: string | null;
  license_number: string | null;
  response_time: string | null;
  office_hours: string | null;
  linkedin_url: string | null;
  instagram_url: string | null;
  profile_verified: number | null;
  profile_published: number | null;
  created_at: string | null;
};

const PROFILE_SELECT = `
  id, email, name, role, phone, avatar_url, agent_title, account_status,
  bio, organization_name, organization_role, organization_website,
  organization_address, organization_logo_url, public_email, website_url,
  service_areas, specialties, languages, professional_memberships,
  years_experience, license_body, license_number, response_time, office_hours,
  linkedin_url, instagram_url, profile_verified, profile_published, created_at
`;

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
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]/)
      : [];
  return source
    .slice(0, MAX_ARRAY)
    .map(item => sanitizeString(item, itemLength))
    .filter(Boolean);
}

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function validHttpsUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validMediaUrl(value: string): boolean {
  return !value || value.startsWith('/api/images/') || validHttpsUrl(value);
}

async function profileForUser(c: any, userId: number): Promise<UserProfileRow | null> {
  const row = await c.env.DB.prepare(
    `SELECT ${PROFILE_SELECT} FROM users WHERE id = ?`,
  ).bind(userId).first();
  return row as UserProfileRow | null;
}

function profileDto(profile: UserProfileRow) {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name || '',
    role: profile.role,
    phone: profile.phone || '',
    avatar_url: profile.avatar_url || '',
    agent_title: profile.agent_title || 'Listing Agent',
    account_status: profile.account_status,
    bio: profile.bio || '',
    organization_name: profile.organization_name || '',
    organization_role: profile.organization_role || '',
    organization_website: profile.organization_website || '',
    organization_address: profile.organization_address || '',
    organization_logo_url: profile.organization_logo_url || '',
    public_email: profile.public_email || '',
    website_url: profile.website_url || '',
    service_areas: safeJsonParse(profile.service_areas, []),
    specialties: safeJsonParse(profile.specialties, []),
    languages: safeJsonParse(profile.languages, []),
    professional_memberships: safeJsonParse(profile.professional_memberships, []),
    years_experience: Number(profile.years_experience || 0),
    license_body: profile.license_body || '',
    license_number: profile.license_number || '',
    response_time: profile.response_time || '',
    office_hours: profile.office_hours || '',
    linkedin_url: profile.linkedin_url || '',
    instagram_url: profile.instagram_url || '',
    profile_verified: Boolean(profile.profile_verified),
    profile_published: Boolean(profile.profile_published),
    created_at: profile.created_at || '',
  };
}

function publicProfileDto(profile: UserProfileRow, listings: any[]) {
  return {
    id: profile.id,
    name: profile.name || '',
    agentTitle: profile.agent_title || 'Listing Agent',
    avatarUrl: profile.avatar_url || '',
    bio: profile.bio || '',
    organization: {
      name: profile.organization_name || '',
      role: profile.organization_role || '',
      website: profile.organization_website || '',
      address: profile.organization_address || '',
      logoUrl: profile.organization_logo_url || '',
    },
    contact: {
      phone: profile.phone || '',
      email: profile.public_email || '',
      website: profile.website_url || '',
      officeHours: profile.office_hours || '',
      responseTime: profile.response_time || '',
      linkedinUrl: profile.linkedin_url || '',
      instagramUrl: profile.instagram_url || '',
    },
    serviceAreas: safeJsonParse(profile.service_areas, []),
    specialties: safeJsonParse(profile.specialties, []),
    languages: safeJsonParse(profile.languages, []),
    professionalMemberships: safeJsonParse(profile.professional_memberships, []),
    yearsExperience: Number(profile.years_experience || 0),
    credential: {
      body: profile.license_body || '',
      number: profile.license_number || '',
    },
    verified: Boolean(profile.profile_verified),
    memberSince: profile.created_at || '',
    activeListingCount: listings.length,
    listings,
  };
}

function editableProfileUpdates(body: Record<string, any>, includeVerification: boolean) {
  const updates: Record<string, string | number> = {};

  if (body.name !== undefined) {
    const name = sanitizeString(body.name, 200);
    if (!name) throw new Error('Name is required');
    updates.name = name;
  }
  if (body.phone !== undefined) updates.phone = sanitizeString(body.phone, 50);
  if (body.agent_title !== undefined) {
    updates.agent_title = sanitizeString(body.agent_title, 120) || 'Listing Agent';
  }
  if (body.avatar_url !== undefined) {
    const avatar = sanitizeString(body.avatar_url, 1000);
    if (!validMediaUrl(avatar)) throw new Error('Profile picture must use HTTPS or an uploaded PrimeProp image');
    updates.avatar_url = avatar;
  }

  const strings: Array<[string, number]> = [
    ['bio', 3000],
    ['organization_name', 200],
    ['organization_role', 160],
    ['organization_address', 500],
    ['license_body', 100],
    ['license_number', 120],
    ['response_time', 120],
    ['office_hours', 250],
  ];
  for (const [field, maxLength] of strings) {
    if (body[field] !== undefined) updates[field] = sanitizeString(body[field], maxLength);
  }

  const urls = ['organization_website', 'website_url', 'linkedin_url', 'instagram_url'];
  for (const field of urls) {
    if (body[field] === undefined) continue;
    const value = sanitizeString(body[field], 1000);
    if (!validHttpsUrl(value)) throw new Error(`${field} must be a valid HTTPS URL`);
    updates[field] = value;
  }

  if (body.organization_logo_url !== undefined) {
    const value = sanitizeString(body.organization_logo_url, 1000);
    if (!validMediaUrl(value)) throw new Error('Organisation logo must use HTTPS or an uploaded PrimeProp image');
    updates.organization_logo_url = value;
  }

  if (body.public_email !== undefined) {
    const email = sanitizeString(body.public_email, 254).toLowerCase();
    if (email && !validEmail(email)) throw new Error('Public email is not valid');
    updates.public_email = email;
  }

  const arrays: Array<[string, number]> = [
    ['service_areas', 120],
    ['specialties', 120],
    ['languages', 80],
    ['professional_memberships', 160],
  ];
  for (const [field, maxLength] of arrays) {
    if (body[field] !== undefined) {
      updates[field] = JSON.stringify(cleanStringArray(body[field], maxLength));
    }
  }

  if (body.years_experience !== undefined) {
    updates.years_experience = sanitizePositiveInt(body.years_experience, 0, 0, 80);
  }
  if (body.profile_published !== undefined) updates.profile_published = body.profile_published ? 1 : 0;
  if (includeVerification && body.profile_verified !== undefined) {
    updates.profile_verified = body.profile_verified ? 1 : 0;
  }

  return updates;
}

async function updateProfile(c: any, userId: number, body: Record<string, any>, includeVerification: boolean) {
  let updates: Record<string, string | number>;
  try {
    updates = editableProfileUpdates(body, includeVerification);
  } catch (error) {
    return c.json({
      success: false,
      message: error instanceof Error ? error.message : 'Invalid profile details',
    }, 400);
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ success: false, message: 'No editable profile fields were supplied' }, 400);
  }

  const clauses = Object.keys(updates).map(field => `${field} = ?`);
  await c.env.DB.prepare(
    `UPDATE users SET ${clauses.join(', ')}, updated_at = datetime('now') WHERE id = ?`,
  ).bind(...Object.values(updates), userId).run();

  const profile = await profileForUser(c, userId);
  if (!profile) return c.json({ success: false, message: 'Profile not found after update' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ success: true, message: 'Profile updated', data: profileDto(profile) });
}

authRoutes.get('/public-agents/:id', async c => {
  c.header('Cache-Control', 'no-store');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Agent not found' }, 404);

  const profile = await c.env.DB.prepare(
    `SELECT ${PROFILE_SELECT}
     FROM users
     WHERE id = ?
       AND role = 'agent'
       AND account_status = 'active'
       AND profile_published = 1`,
  ).bind(id).first<UserProfileRow>();
  if (!profile) return c.json({ success: false, message: 'Agent not found' }, 404);

  const result = await c.env.DB.prepare(
    `SELECT * FROM listings
     WHERE created_by = ?
       AND approval_status = 'approved'
     ORDER BY featured DESC, id DESC
     LIMIT 100`,
  ).bind(id).all();
  const listings = (result.results || []).map(row => rowToListing(row));

  return c.json({ success: true, data: publicProfileDto(profile, listings) });
});

authRoutes.get('/profile-settings', requireAuth, async c => {
  c.header('Cache-Control', 'no-store');
  const user = c.get('user');
  const profile = await profileForUser(c, user.id);
  if (!profile) return c.json({ success: false, message: 'Profile not found' }, 404);
  return c.json({ success: true, data: profileDto(profile) });
});

authRoutes.put('/profile-settings', csrfProtection, requireAuth, async c => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => null) as Record<string, any> | null;
  if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);
  return updateProfile(c, user.id, body, false);
});

authRoutes.put(
  '/admin-profile-settings/:id',
  csrfProtection,
  requireAuth,
  requireRole('admin'),
  async c => {
    const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
    if (!id) return c.json({ success: false, message: 'Invalid user ID' }, 400);
    const target = await profileForUser(c, id);
    if (!target) return c.json({ success: false, message: 'User not found' }, 404);
    if (target.role !== 'agent') {
      return c.json({ success: false, message: 'Public profiles are available for agent accounts only' }, 409);
    }
    const body = await c.req.json().catch(() => null) as Record<string, any> | null;
    if (!body) return c.json({ success: false, message: 'Invalid request' }, 400);
    return updateProfile(c, id, body, true);
  },
);

authRoutes.get('/admin-listings', requireAuth, requireRole('admin'), async c => {
  c.header('Cache-Control', 'no-store');
  const query = c.req.query();
  const page = sanitizePositiveInt(query.page, 1, 1, 1000);
  const limit = sanitizePositiveInt(query.limit, 100, 1, 100);
  const offset = (page - 1) * limit;
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS c FROM listings').first<{ c: number }>();
  const total = count?.c || 0;
  const totalPages = Math.ceil(total / limit) || 1;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM listings ORDER BY featured DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
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

authRoutes.post('/listing-records', csrfProtection, requireAuth, async c => {
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

authRoutes.put('/listing-records/:id', csrfProtection, requireAuth, async c => {
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
