// Shared helpers used by both index.ts and auth.ts

export function safeJsonParse(val: any, fallback: any) {
  if (!val) return fallback;
  try { return typeof val === 'string' ? JSON.parse(val) : val; } catch { return fallback; }
}

export function isYouTube(url: string): boolean {
  if (!url) return false;
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)/i.test(url);
}

export function rowToListing(row: any) {
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
