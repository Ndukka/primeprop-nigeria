/**
 * PP-SEC-010 / PP-SEC-011: Security Headers & Strict CSP
 *
 * Provides nonce generation, CSP header construction, HTML nonce injection,
 * and security header setters for HTML, assets, and API responses.
 */

export function generateNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * CSP for HTML pages.
 *
 * The deployable dist-public bundle contains no style attributes, inline event
 * attributes, inline script blocks, or inline style blocks. All executable
 * scripts and runtime-generated styles receive the per-response nonce.
 */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'nonce-" + nonce + "' 'strict-dynamic'",
    "script-src-attr 'none'",
    "style-src 'self' 'nonce-" + nonce + "' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "style-src-elem 'self' 'nonce-" + nonce + "' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "style-src-attr 'none'",
    "img-src 'self' data: blob: https://images.unsplash.com https://randomuser.me https://lh3.googleusercontent.com",
    "font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function replaceNonceAttribute(attrs: string, nonce: string): string {
  const withoutExistingNonce = attrs.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return ` nonce="${nonce}"${withoutExistingNonce}`;
}

/**
 * Injects a fresh nonce into every external script and any runtime-created
 * style element placeholder. Existing nonce attributes are replaced rather
 * than duplicated. The function does not inject compatibility assets.
 */
export function injectNonces(html: string, nonce: string): string {
  html = html.replace(/<script(\s[^>]*)?>/gi, (_match, attrs = '') => {
    return `<script${replaceNonceAttribute(attrs, nonce)}>`;
  });

  html = html.replace(/<style(\s[^>]*)?>/gi, (_match, attrs = '') => {
    return `<style${replaceNonceAttribute(attrs, nonce)}>`;
  });

  return html;
}

export function setHtmlSecurityHeaders(headers: Headers, nonce: string): void {
  headers.set('Content-Security-Policy', buildCsp(nonce));

  // HTML is rewritten on every request to inject a fresh CSP nonce. It must
  // never retain validators or cache metadata from the underlying static
  // asset response, otherwise a browser can reuse HTML from an older build
  // while loading JavaScript from a newer one.
  for (const header of [
    'Age',
    'Content-Length',
    'ETag',
    'Last-Modified',
    'Surrogate-Control',
  ]) {
    headers.delete(header);
  }
  headers.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
  headers.set('Pragma', 'no-cache');
  headers.set('Expires', '0');

  setCommonSecurityHeaders(headers);
}

export function setAssetSecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
}

export function setApiSecurityHeaders(headers: Headers): void {
  headers.set('Content-Security-Policy', API_CSP);
  setCommonSecurityHeaders(headers);
}

function setCommonSecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

export function isHtmlPath(path: string): boolean {
  if (path === '/' || path === '') return true;

  const staticExts = /\.(css|js|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|pdf|mp4|webm|mov)$/i;
  if (staticExts.test(path)) return false;

  if (/\.html$/i.test(path)) return true;
  return !path.includes('.');
}
