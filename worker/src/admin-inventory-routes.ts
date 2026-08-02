import { authRoutes, csrfProtection, requireAuth, requireRole } from './auth';
import { safeJsonParse, sanitizePositiveInt } from './utils';

type SchemaColumn = { name: string };

type DistrictRow = {
  id: number;
  name: string;
  city: string;
  description: string | null;
  checks: string | null;
  image: string | null;
  link_type: string | null;
  created_at: string | null;
};

type ListingContactRow = {
  title: string;
  location: string;
  price: number;
  phone: string | null;
};

type ListingOwnerRow = {
  id: number;
  created_by: number | null;
};

function districtDto(district: DistrictRow) {
  return {
    id: district.id,
    name: district.name,
    city: district.city,
    description: district.description || '',
    checks: safeJsonParse(district.checks, []),
    image: district.image || '',
    linkType: district.link_type || 'all',
    createdAt: district.created_at || '',
  };
}

async function districtRows(c: any) {
  const result = await c.env.DB.prepare(
    `SELECT id, name, city, description, checks, image, link_type, created_at
     FROM districts
     ORDER BY id ASC`,
  ).all();
  return ((result.results || []) as DistrictRow[]).map(districtDto);
}

async function usersProjection(c: any): Promise<string> {
  const schema = await c.env.DB.prepare('PRAGMA table_info(users)').all();
  const columns = new Set(
    ((schema.results || []) as SchemaColumn[]).map((column: SchemaColumn) => column.name),
  );

  const required = ['id', 'email', 'name', 'role', 'avatar_url', 'phone', 'created_at'];
  for (const column of required) {
    if (!columns.has(column)) {
      throw new Error(`users schema is missing required column: ${column}`);
    }
  }

  return [
    'id',
    'email',
    'name',
    'role',
    'avatar_url',
    'phone',
    columns.has('account_status')
      ? "COALESCE(account_status, 'active') AS account_status"
      : "'active' AS account_status",
    columns.has('last_login_at')
      ? 'last_login_at'
      : 'NULL AS last_login_at',
    columns.has('login_count')
      ? 'COALESCE(login_count, 0) AS login_count'
      : '0 AS login_count',
    'created_at',
  ].join(', ');
}

function userDto(user: any) {
  return {
    id: Number(user.id),
    email: String(user.email || ''),
    name: String(user.name || ''),
    role: user.role === 'admin' ? 'admin' : 'agent',
    avatarUrl: String(user.avatar_url || ''),
    phone: String(user.phone || ''),
    accountStatus: String(user.account_status || 'active'),
    lastLoginAt: user.last_login_at == null ? '' : String(user.last_login_at),
    loginCount: Number(user.login_count || 0),
    createdAt: user.created_at == null ? '' : String(user.created_at),
  };
}

function normalizeContactNumber(value: unknown): string {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `234${digits.slice(1)}`;
  return /^\d{10,15}$/.test(digits) ? digits : '';
}

async function listingContact(c: any, id: number): Promise<ListingContactRow | null> {
  const row = await c.env.DB.prepare(
    `SELECT l.title, l.location, l.price,
            CASE
              WHEN l.created_by IS NULL THEN NULLIF(l.agent_phone, '')
              WHEN u.id IS NOT NULL THEN COALESCE(NULLIF(l.agent_phone, ''), NULLIF(u.phone, ''))
              ELSE NULL
            END AS phone
     FROM listings l
     LEFT JOIN users u
       ON u.id = l.created_by
      AND COALESCE(u.account_status, 'active') = 'active'
     WHERE l.id = ?`,
  ).bind(id).first();
  return row as ListingContactRow | null;
}

authRoutes.get('/district-guides', async c => {
  c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  const data = await districtRows(c);
  return c.json({ success: true, count: data.length, data });
});

authRoutes.get('/admin-districts', requireAuth, requireRole('admin'), async c => {
  c.header('Cache-Control', 'no-store');
  const data = await districtRows(c);
  return c.json({ success: true, count: data.length, data });
});

authRoutes.get('/admin-users', requireAuth, requireRole('admin'), async c => {
  c.header('Cache-Control', 'no-store');
  const projection = await usersProjection(c);
  const result = await c.env.DB.prepare(
    `SELECT ${projection} FROM users ORDER BY id ASC`,
  ).all();
  const data = (result.results || []).map(userDto);
  return c.json({ success: true, count: data.length, data });
});

authRoutes.get('/admin-users/:id', requireAuth, requireRole('admin'), async c => {
  c.header('Cache-Control', 'no-store');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid user ID' }, 400);

  const projection = await usersProjection(c);
  const user = await c.env.DB.prepare(
    `SELECT ${projection} FROM users WHERE id = ?`,
  ).bind(id).first();
  if (!user) return c.json({ success: false, message: 'User not found' }, 404);
  return c.json({ success: true, data: userDto(user) });
});

authRoutes.delete('/listing-records/:id', csrfProtection, requireAuth, async c => {
  const user = c.get('user');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid listing ID' }, 400);

  const listing = await c.env.DB.prepare(
    'SELECT id, created_by FROM listings WHERE id = ?',
  ).bind(id).first() as ListingOwnerRow | null;
  if (!listing) return c.json({ success: false, message: 'Listing not found' }, 404);
  if (user.role !== 'admin' && listing.created_by !== user.id) {
    return c.json({ success: false, message: 'You can only delete your own listings' }, 403);
  }

  await c.env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'Listing deleted' });
});

authRoutes.get('/listing-contact/:id/whatsapp', async c => {
  c.header('Cache-Control', 'no-store');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid listing ID' }, 400);

  const contact = await listingContact(c, id);
  if (!contact) return c.json({ success: false, message: 'Listing not found' }, 404);
  const phone = normalizeContactNumber(contact.phone);
  if (!phone) return c.json({ success: false, message: 'Agent contact is not available' }, 404);

  const text = [
    `Hello, I'm interested in ${contact.title}`,
    contact.location ? `in ${contact.location}` : '',
    Number.isFinite(Number(contact.price)) ? `(₦${Number(contact.price).toLocaleString()})` : '',
    'Is it still available? I would like to schedule an inspection.',
  ].filter(Boolean).join(' ');

  return c.redirect(`https://wa.me/${phone}?text=${encodeURIComponent(text)}`, 302);
});

authRoutes.get('/listing-contact/:id/call', async c => {
  c.header('Cache-Control', 'no-store');
  const id = sanitizePositiveInt(c.req.param('id'), 0, 1, Number.MAX_SAFE_INTEGER);
  if (!id) return c.json({ success: false, message: 'Invalid listing ID' }, 400);

  const contact = await listingContact(c, id);
  if (!contact) return c.json({ success: false, message: 'Listing not found' }, 404);
  const phone = normalizeContactNumber(contact.phone);
  if (!phone) return c.json({ success: false, message: 'Agent contact is not available' }, 404);

  return c.redirect(`tel:+${phone}`, 302);
});
