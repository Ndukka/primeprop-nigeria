import type { D1Database, R2Bucket, R2Object } from '@cloudflare/workers-types';
import {
  ALLOWED_CONTENT_TYPES,
  MAX_IMAGE_SIZE,
  MAX_RISKY_SIZE,
  isRiskyType,
} from './file-validator';

type AuditBindings = {
  DB: D1Database;
  IMAGES: R2Bucket;
  PUBLIC_APP_URL?: string;
};

type UploadRow = {
  id: number;
  user_id: number;
  listing_id: number | null;
  object_key: string;
  original_name: string;
  content_type: string;
  size_bytes: number;
  folder: string;
  created_at: string;
};

type ListingMediaRow = {
  id: number;
  images: string | null;
  agent_avatar: string | null;
};

type DistrictMediaRow = {
  id: number;
  image: string | null;
};

type UserMediaRow = {
  id: number;
  avatar_url: string | null;
};

type Reference = {
  source: 'listing' | 'listing-agent-avatar' | 'district' | 'user-avatar';
  sourceId: number;
  value: string;
  key: string | null;
};

type ObjectSummary = {
  key: string;
  size: number;
  uploaded: string;
  etag: string;
  contentType: string | null;
};

type AuditIssue = {
  category: string;
  severity: 'high' | 'medium' | 'low';
  key?: string;
  source?: string;
  sourceId?: number;
  detail: string;
};

const APPROVED_PREFIXES = new Set(['images', 'documents', 'videos']);
const MAX_AUDIT_ITEMS = 5000;

function safeJsonArray(value: string | null): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mediaUrl(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object' && 'url' in value && typeof value.url === 'string') {
    return value.url.trim() || null;
  }
  return null;
}

function extractObjectKey(value: string, publicAppUrl?: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const base = publicAppUrl || 'https://primeprop.invalid';
    const url = new URL(trimmed, base);
    const marker = '/api/images/';
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    const encodedKey = url.pathname.slice(index + marker.length);
    if (!encodedKey) return null;
    return decodeURIComponent(encodedKey);
  } catch {
    return null;
  }
}

function isSuspiciousKey(key: string): boolean {
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('..')) return true;
  if (/[%\u0000-\u001f\u007f]/.test(key)) return true;
  const prefix = key.split('/', 1)[0];
  return !APPROVED_PREFIXES.has(prefix);
}

function objectContentType(object: R2Object): string | null {
  return object.httpMetadata?.contentType || null;
}

async function listAllObjects(bucket: R2Bucket): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;

  do {
    const page = await bucket.list({
      limit: 1000,
      cursor,
      include: ['httpMetadata', 'customMetadata'],
    });
    objects.push(...page.objects);
    if (objects.length > MAX_AUDIT_ITEMS) {
      throw new Error(`R2 audit exceeds the safe limit of ${MAX_AUDIT_ITEMS} objects`);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return objects;
}

function addReference(
  references: Reference[],
  source: Reference['source'],
  sourceId: number,
  value: string | null,
  publicAppUrl?: string,
): void {
  if (!value?.trim()) return;
  references.push({
    source,
    sourceId,
    value: value.trim(),
    key: extractObjectKey(value, publicAppUrl),
  });
}

export async function auditStorage(env: AuditBindings): Promise<Record<string, unknown>> {
  const [uploadsResult, listingsResult, districtsResult, usersResult, objects] = await Promise.all([
    env.DB.prepare(
      `SELECT id, user_id, listing_id, object_key, original_name,
              content_type, size_bytes, folder, created_at
       FROM upload_objects
       ORDER BY id`
    ).all<UploadRow>(),
    env.DB.prepare('SELECT id, images, agent_avatar FROM listings ORDER BY id').all<ListingMediaRow>(),
    env.DB.prepare('SELECT id, image FROM districts ORDER BY id').all<DistrictMediaRow>(),
    env.DB.prepare('SELECT id, avatar_url FROM users ORDER BY id').all<UserMediaRow>(),
    listAllObjects(env.IMAGES),
  ]);

  const uploads = uploadsResult.results;
  const references: Reference[] = [];

  for (const listing of listingsResult.results) {
    for (const media of safeJsonArray(listing.images)) {
      addReference(references, 'listing', listing.id, mediaUrl(media), env.PUBLIC_APP_URL);
    }
    addReference(references, 'listing-agent-avatar', listing.id, listing.agent_avatar, env.PUBLIC_APP_URL);
  }
  for (const district of districtsResult.results) {
    addReference(references, 'district', district.id, district.image, env.PUBLIC_APP_URL);
  }
  for (const user of usersResult.results) {
    addReference(references, 'user-avatar', user.id, user.avatar_url, env.PUBLIC_APP_URL);
  }

  const trackedByKey = new Map(uploads.map(row => [row.object_key, row]));
  const objectByKey = new Map(objects.map(object => [object.key, object]));
  const referencedKeys = new Set(references.flatMap(reference => reference.key ? [reference.key] : []));
  const issues: AuditIssue[] = [];

  for (const object of objects) {
    const tracked = trackedByKey.get(object.key);
    const contentType = objectContentType(object);

    if (!tracked) {
      issues.push({
        category: 'r2-untracked',
        severity: 'high',
        key: object.key,
        detail: 'Object exists in R2 but has no upload_objects ownership record.',
      });
    }
    if (isSuspiciousKey(object.key)) {
      issues.push({
        category: 'suspicious-object-key',
        severity: 'high',
        key: object.key,
        detail: 'Object key contains traversal/control syntax or an unapproved folder prefix.',
      });
    }
    if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
      issues.push({
        category: 'unapproved-r2-content-type',
        severity: 'high',
        key: object.key,
        detail: `R2 metadata content type is ${contentType || 'missing'}.`,
      });
    }
    const sizeLimit = contentType && isRiskyType(contentType) ? MAX_RISKY_SIZE : MAX_IMAGE_SIZE;
    if (object.size > sizeLimit) {
      issues.push({
        category: 'oversized-r2-object',
        severity: 'high',
        key: object.key,
        detail: `Object size ${object.size} exceeds the allowed limit ${sizeLimit}.`,
      });
    }
  }

  for (const upload of uploads) {
    const object = objectByKey.get(upload.object_key);
    if (!object) {
      issues.push({
        category: 'database-object-missing-in-r2',
        severity: 'high',
        key: upload.object_key,
        detail: `upload_objects row ${upload.id} points to an object that does not exist.`,
      });
      continue;
    }
    if (!referencedKeys.has(upload.object_key)) {
      issues.push({
        category: 'tracked-but-unreferenced',
        severity: 'medium',
        key: upload.object_key,
        detail: `Tracked upload row ${upload.id} is not referenced by a listing, district, or avatar.`,
      });
    }
    if (!ALLOWED_CONTENT_TYPES.has(upload.content_type)) {
      issues.push({
        category: 'unapproved-database-content-type',
        severity: 'high',
        key: upload.object_key,
        detail: `Database content type ${upload.content_type} is not approved.`,
      });
    }
    if (object.size !== upload.size_bytes) {
      issues.push({
        category: 'size-metadata-mismatch',
        severity: 'medium',
        key: upload.object_key,
        detail: `D1 records ${upload.size_bytes} bytes but R2 reports ${object.size}.`,
      });
    }
  }

  for (const reference of references) {
    if (reference.key) {
      if (!objectByKey.has(reference.key)) {
        issues.push({
          category: 'referenced-object-missing-in-r2',
          severity: 'high',
          key: reference.key,
          source: reference.source,
          sourceId: reference.sourceId,
          detail: 'Application record references an R2 key that does not exist.',
        });
      }
      if (!trackedByKey.has(reference.key)) {
        issues.push({
          category: 'referenced-object-untracked',
          severity: 'high',
          key: reference.key,
          source: reference.source,
          sourceId: reference.sourceId,
          detail: 'Application record references R2 media without an ownership row.',
        });
      }
      continue;
    }

    let parsed: URL | null = null;
    try {
      parsed = new URL(reference.value, env.PUBLIC_APP_URL || 'https://primeprop.invalid');
    } catch {
      // Invalid URLs are reported below.
    }

    if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) {
      issues.push({
        category: 'invalid-media-url',
        severity: 'high',
        source: reference.source,
        sourceId: reference.sourceId,
        detail: `Invalid media reference: ${reference.value.slice(0, 200)}`,
      });
    } else if (parsed.protocol !== 'https:') {
      issues.push({
        category: 'insecure-external-media-url',
        severity: 'medium',
        source: reference.source,
        sourceId: reference.sourceId,
        detail: `Non-HTTPS media host: ${parsed.host}`,
      });
    }
  }

  const countsByCategory = Object.fromEntries(
    [...new Set(issues.map(issue => issue.category))]
      .sort()
      .map(category => [category, issues.filter(issue => issue.category === category).length]),
  );

  const objectSummaries: ObjectSummary[] = objects.map(object => ({
    key: object.key,
    size: object.size,
    uploaded: object.uploaded.toISOString(),
    etag: object.etag,
    contentType: objectContentType(object),
  }));

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    limits: { maxAuditItems: MAX_AUDIT_ITEMS },
    counts: {
      uploadRows: uploads.length,
      r2Objects: objects.length,
      mediaReferences: references.length,
      issues: issues.length,
      high: issues.filter(issue => issue.severity === 'high').length,
      medium: issues.filter(issue => issue.severity === 'medium').length,
      low: issues.filter(issue => issue.severity === 'low').length,
      byCategory: countsByCategory,
    },
    issues,
    inventory: {
      uploads,
      r2Objects: objectSummaries,
      references,
    },
  };
}
