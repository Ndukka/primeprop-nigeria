import { authRoutes, requireAuth, requireRole } from './auth';
import { safeJsonParse } from './utils';

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

async function usersProjection(c: any): Promise<string> {
  const schema = await c.env.DB.prepare('PRAGMA table_info(users)').all<SchemaColumn>();
  const columns = new Set((schema.results || []).map(column => column.name));

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

authRoutes.get('/admin-districts', requireAuth, requireRole('admin'), async c => {
  c.header('Cache-Control', 'no-store');
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, city, description, checks, image, link_type, created_at
     FROM districts
     ORDER BY id ASC`,
  ).all<DistrictRow>();

  const data = (results || []).map(district => ({
    id: district.id,
    name: district.name,
    city: district.city,
    description: district.description || '',
    checks: safeJsonParse(district.checks, []),
    image: district.image || '',
    linkType: district.link_type || 'all',
    createdAt: district.created_at || '',
  }));

  return c.json({ success: true, count: data.length, data });
});

authRoutes.get('/admin-users', requireAuth, requireRole('admin'), async c => {
  c.header('Cache-Control', 'no-store');
  const projection = await usersProjection(c);
  const { results } = await c.env.DB.prepare(
    `SELECT ${projection} FROM users ORDER BY id ASC`,
  ).all();

  const data = (results || []).map((user: any) => ({
    id: Number(user.id),
    email: String(user.email || ''),
    name: String(user.name || ''),
    role: String(user.role || 'agent'),
    avatarUrl: String(user.avatar_url || ''),
    phone: String(user.phone || ''),
    accountStatus: String(user.account_status || 'active'),
    lastLoginAt: user.last_login_at == null ? '' : String(user.last_login_at),
    loginCount: Number(user.login_count || 0),
    createdAt: user.created_at == null ? '' : String(user.created_at),
  }));

  return c.json({ success: true, count: data.length, data });
});
