// ── File Validator ─────────────────────────────────────────
// PP-SEC-015: Magic byte validation, dangerous extension detection,
// safe content-type whitelist, and attachment disposition logic.

// ── Magic byte signatures ────────────────────────────────

const MAGIC_SIGNATURES: { signature: number[]; type: string; description: string }[] = [
  // Images
  { signature: [0xFF, 0xD8, 0xFF],                            type: 'image/jpeg',    description: 'JPEG' },
  { signature: [0x89, 0x50, 0x4E, 0x47],                      type: 'image/png',     description: 'PNG' },
  { signature: [0x47, 0x49, 0x46, 0x38],                      type: 'image/gif',     description: 'GIF' },
  // PDF
  { signature: [0x25, 0x50, 0x44, 0x46],                      type: 'application/pdf', description: 'PDF' },
];

// WebP: RIFF header (52 49 46 46) + WEBP at offset 8 (57 45 42 50)
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_BRAND    = [0x57, 0x45, 0x42, 0x50];

// ISOBMFF-based formats: box size (4 bytes) + brand "ftyp" (4 bytes) + brand code (4 bytes)
// Signature check: offset 4-7 must be "ftyp" (66 74 79 70)
const FTYP_SIGNATURE = [0x66, 0x74, 0x79, 0x70]; // "ftyp" at offset 4
const AVIF_BRAND     = [0x61, 0x76, 0x69, 0x66]; // "avif"

// MP4-compatible ftyp brand codes
const MP4_BRANDS = new Set([
  'mp42', 'isom', 'avc1', 'mmp4', 'mp41', 'iso2', 'iso5', 'iso6',
  'msnv', 'ndas', 'ndsc', 'ndsh', 'ndsm', 'ndsp', 'ndss',
  'ndxc', 'ndxh', 'ndxm', 'ndxp', 'ndxs',
]);

// QuickTime
const QT_BRAND = 'qt  ';

// ── Allowed MIME types (checked before magic byte validation) ──
export const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'application/pdf',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const RISKY_TYPES = new Set(['application/pdf', 'video/mp4', 'video/webm', 'video/quicktime']);

// ── Safe content-type whitelist for serving ──────────────
const EXT_TO_CONTENT_TYPE: Record<string, string> = {
  'jpg':  'image/jpeg',
  'jpeg': 'image/jpeg',
  'png':  'image/png',
  'gif':  'image/gif',
  'webp': 'image/webp',
  'avif': 'image/avif',
  'pdf':  'application/pdf',
  'mp4':  'video/mp4',
  'webm': 'video/webm',
  'mov':  'video/quicktime',
};

// ── Types that require Content-Disposition: attachment ───
const ATTACHMENT_EXTENSIONS = new Set(['pdf', 'mp4', 'webm', 'mov']);

// ── Dangerous extension patterns ─────────────────────────
// Double extensions: .php.jpg, .html.png, .exe.pdf, etc.
const DOUBLE_EXT_REGEX = /\.[a-z0-9]{2,5}\.[a-z0-9]{2,5}$/i;
// Execution-capable extensions anywhere in the filename
const DANGEROUS_EXTS = /\.(php[0-9a-z]?|phtml|phar|asp|aspx|ashx|asmx|jsp|jspx|cgi|pl|py|pyc|pyo|pyd|sh|bash|zsh|exe|bin|dll|so|dylib|bat|cmd|com|msi|scr|vbs|vbe|ps1|psm1|psd1|wsf|wsh|jar|war|ear|hta|sct|reg|lnk)(\.|$)/i;

// ── Validation result ────────────────────────────────────
export interface ValidationResult {
  valid: boolean;
  error?: string;
  detectedType?: string;
  extension?: string;
}

// ── Magic byte detection ─────────────────────────────────

/**
 * Validate file content by checking magic bytes / file signatures.
 * Read at least the first 16 bytes to cover all supported formats.
 * 
 * Detection order (first match wins):
 *   1. JPEG: FF D8 FF
 *   2. PNG:  89 50 4E 47
 *   3. GIF:  47 49 46 38
 *   4. WebP: 52 49 46 46 ... 57 45 42 50 (RIFF + WEBP at offset 8)
 *   5. PDF:  25 50 44 46
 *   6. AVIF: ftyp box with "avif" brand
 *   7. MP4:  ftyp box with known MP4 brands
 *   8. QuickTime: ftyp box with "qt  " brand
 */
export function detectFileType(bytes: Uint8Array): { valid: boolean; detectedType?: string; description?: string } {
  if (bytes.length < 4) {
    return { valid: false };
  }

  // 1. Check fixed-magic signatures
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.signature.every((b, i) => bytes[i] === b)) {
      return { valid: true, detectedType: sig.type, description: sig.description };
    }
  }

  // 2. WebP: RIFF header + needs at least 12 bytes
  if (bytes.length >= 12 && RIFF_SIGNATURE.every((b, i) => bytes[i] === b)) {
    if (WEBP_BRAND.every((b, i) => bytes[i + 8] === b)) {
      return { valid: true, detectedType: 'image/webp', description: 'WebP' };
    }
    // RIFF but not WebP — could be AVI, WAV, etc. Reject.
    return { valid: false };
  }

  // 3. ISOBMFF-based (AVIF, MP4, QuickTime): check for "ftyp" box at offset 4
  if (bytes.length >= 12 &&
      FTYP_SIGNATURE.every((b, i) => bytes[i + 4] === b)) {

    // Check AVIF brand
    if (AVIF_BRAND.every((b, i) => bytes[i + 8] === b)) {
      return { valid: true, detectedType: 'image/avif', description: 'AVIF' };
    }

    // Check MP4 brands and QuickTime
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (MP4_BRANDS.has(brand)) {
      return { valid: true, detectedType: 'video/mp4', description: 'MP4' };
    }
    if (brand === QT_BRAND) {
      return { valid: true, detectedType: 'video/quicktime', description: 'QuickTime' };
    }
  }

  return { valid: false };
}

// ── Filename validation ──────────────────────────────────

/**
 * Validate filename for security issues:
 * - Double extensions (.php.jpg, .html.png)
 * - Dangerous executable extensions anywhere in name
 * - Empty or missing extension
 * - Path traversal attempts
 */
export function validateFilename(filename: string): ValidationResult {
  if (!filename || filename.trim().length === 0) {
    return { valid: false, error: 'Empty filename' };
  }

  // Path traversal check
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { valid: false, error: `Invalid filename (path traversal): ${filename}` };
  }

  // Dangerous executable extensions
  if (DANGEROUS_EXTS.test(filename)) {
    return { valid: false, error: `Dangerous file extension: ${filename}` };
  }

  // Double extension check
  if (DOUBLE_EXT_REGEX.test(filename)) {
    return { valid: false, error: `Double extension not allowed: ${filename}` };
  }

  // Extract extension
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === filename.length - 1) {
    return { valid: false, error: `File must have an extension: ${filename}` };
  }

  const ext = filename.slice(dotIdx + 1).toLowerCase();

  return { valid: true, extension: ext };
}

// ── Content-type whitelist for serving ───────────────────

/**
 * Returns the safe Content-Type for a file extension.
 * Never trusts user-supplied Content-Type metadata.
 */
export function getSafeContentType(extension: string): string | undefined {
  return EXT_TO_CONTENT_TYPE[extension.toLowerCase()];
}

// ── Content-Disposition: attachment for risky types ──────

/**
 * Returns true if files with this extension should be served as
 * downloads (Content-Disposition: attachment) rather than inline.
 * PDFs and videos are risky because they can contain embedded
 * scripts, phishing links, or drive-by-downloads.
 */
export function requiresAttachmentDisposition(extension: string): boolean {
  return ATTACHMENT_EXTENSIONS.has(extension.toLowerCase());
}

// ── File type categorization ─────────────────────────────

export function isImageType(mimeType: string): boolean {
  return IMAGE_TYPES.has(mimeType);
}

export function isRiskyType(mimeType: string): boolean {
  return RISKY_TYPES.has(mimeType);
}

// ── File size limits (in bytes) ──────────────────────────
export const MAX_IMAGE_SIZE  = 10 * 1024 * 1024;   // 10 MB
export const MAX_RISKY_SIZE  = 50 * 1024 * 1024;   // 50 MB
export const MAX_FILES_PER_REQUEST = 5;
export const MAX_UPLOADS_PER_USER_PER_DAY = 50;

// ── Cache-Control header based on file extension ─────────
// PP-SEC-032: Images are immutable (UUID keys never change content).
// PDFs/videos use a shorter cache because they may be moderated.
export function getCacheControl(extension: string): string {
  if (ATTACHMENT_EXTENSIONS.has(extension.toLowerCase())) {
    return 'public, max-age=86400'; // 24h for PDFs/videos
  }
  return 'public, max-age=31536000, immutable'; // 1 year for images
}

// ── R2 folder prefix based on MIME type ──────────────────
export function getR2FolderPrefix(mimeType: string): string {
  if (mimeType.startsWith('image/'))  return 'images';
  if (mimeType === 'application/pdf') return 'documents';
  if (mimeType.startsWith('video/'))  return 'videos';
  return 'other';
}

// ── Additional image header integrity checks ─────────────

/**
 * Perform deeper structural checks on image headers beyond magic bytes.
 * These catch malformed headers in polyglot files.
 * 
 * JPEG: validate that byte after SOI marker (FF D8) is a valid marker (FF E0-E1, FE, DB, C0-C4, etc.)
 * PNG:  validate IHDR chunk follows the signature (offset 12-15 = "IHDR")
 * GIF:  validate version is "87a" or "89a" (offset 4-5)
 */
export function validateImageHeaders(bytes: Uint8Array, mimeType: string): ValidationResult {
  // JPEG: after FF D8 FF, next byte must be a marker (0xE0-0xEF, 0xFE, 0xDB, 0xC0-0xC4, etc.)
  if (mimeType === 'image/jpeg') {
    if (bytes.length < 4) return { valid: false, error: 'JPEG: file too small for header validation' };
    const marker = bytes[3];
    // Valid JPEG markers: E0-E1 (EXIF), FE (comment), DB (DQT), C0-C4 (SOF), C5-C7, C8-CB, CC-CF
    const validMarkers = new Set([0xE0, 0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, 0xED, 0xEE, 0xEF, 0xFE, 0xDB, 0xC0, 0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xCB, 0xCC, 0xCD, 0xCE, 0xCF]);
    if (!validMarkers.has(marker)) {
      return { valid: false, error: 'JPEG: invalid marker after SOI header' };
    }
  }

  // PNG: check IHDR chunk at offset 12 (after 8-byte signature + 4-byte length)
  if (mimeType === 'image/png') {
    if (bytes.length < 16) return { valid: false, error: 'PNG: file too small for header validation' };
    const chunkType = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (chunkType !== 'IHDR') {
      return { valid: false, error: 'PNG: missing IHDR chunk after signature' };
    }
  }

  // GIF: validate version string at offset 3 (should be "87a" or "89a")
  if (mimeType === 'image/gif') {
    if (bytes.length < 6) return { valid: false, error: 'GIF: file too small for header validation' };
    const version = String.fromCharCode(bytes[3], bytes[4], bytes[5]);
    if (version !== '87a' && version !== '89a') {
      return { valid: false, error: `GIF: invalid version '${version}' (expected 87a or 89a)` };
    }
  }

  return { valid: true };
}
