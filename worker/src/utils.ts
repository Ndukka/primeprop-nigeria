// Shared helpers used by both index.ts and auth.ts

// PP-SEC-024: Sanitizes a numeric value to a positive integer clamped within [min, max].
// Returns fallback for non-finite/NaN, floors fractional values, and clamps to range.
export function sanitizePositiveInt(v: unknown, fallback = 0, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v === null) return fallback;
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

export function safeJsonParse(val: any, fallback: any) {
  if (!val) return fallback;
  try { return typeof val === 'string' ? JSON.parse(val) : val; } catch { return fallback; }
}

export function isYouTube(url: string): boolean {
  if (!url) return false;
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(url);
}

// PP-SEC-020: Explicit DTO — never spread raw database rows into API responses.
// Public listing response: only approved fields, no internal columns (created_by, etc).
export function rowToListing(row: any, isAdmin: boolean = false) {
  if (!row) return null;
  const agentName = row.agent_name || '';

  // Base fields always safe for public
  const dto: Record<string, any> = {
    id: row.id,
    title: row.title || '',
    type: row.type || 'rent',
    propertyType: row.property_type || 'apartment',
    price: Number(row.price),
    priceUnit: row.price_unit || '',
    priceDisplay: `₦${Number(row.price).toLocaleString()}`,
    location: row.location || '',
    area: row.area || '',
    city: row.city || '',
    bedrooms: Number(row.bedrooms || 0),
    bathrooms: Number(row.bathrooms || 0),
    sqft: Number(row.sqft || 0),
    parking: Number(row.parking || 0),
    description: row.description || '',
    availability: row.availability || 'Immediately',
    featured: Boolean(row.featured),
    verified: Boolean(row.verified),
    badge: row.badge || '',
    amenities: safeJsonParse(row.amenities, []),
    images: safeJsonParse(row.images, []).map((url: string) => ({
      url,
      type: isYouTube(url) ? 'youtube' :
            url.match(/\.(mp4|webm|mov)(\?|$)/i) ? 'video' :
            url.match(/\.(pdf)(\?|$)/i) ? 'pdf' : 'image'
    })),
    agent: {
      name: agentName,
      role: row.agent_role || '',
      phone: '',  // PP-SEC-020: Agent phone is admin-only
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
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };

  // Admin-only fields (internal ownership, agent contact, moderation data)
  if (isAdmin) {
    dto.createdBy = row.created_by;
    dto.agent.phone = row.agent_phone || '';
    dto.moderationStatus = row.moderation_status || '';
  }

  return dto;
}
