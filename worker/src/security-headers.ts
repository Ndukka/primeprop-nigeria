/**
 * PP-SEC-010 / PP-SEC-011: Security Headers & Strict CSP
 *
 * Provides nonce generation, CSP header construction, HTML nonce injection,
 * and security header setters for both HTML pages and API responses.
 */

// ── Nonce Generation ──────────────────────────────────────
// 192 bits of entropy (24 random bytes), base64url-encoded.
// Regenerated per request so every page load gets a fresh nonce.
export function generateNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── CSP Builders ──────────────────────────────────────────

/**
 * CSP for HTML pages.
 *
 * Scripts remain nonce-only. The current static pages and app.js still use
 * style attributes and element.style assignments, which nonces cannot cover.
 * style-src-attr therefore permits inline CSS attributes only. This does not
 * permit inline JavaScript or event handlers.
 */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'nonce-" + nonce + "' 'strict-dynamic'",
    "script-src-attr 'none'",
    "style-src 'self' 'nonce-" + nonce + "' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "style-src-elem 'self' 'nonce-" + nonce + "' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "style-src-attr 'unsafe-inline'",
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

/**
 * Minimal CSP for JSON API responses.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// ── Nonce Injection ───────────────────────────────────────

function replaceNonceAttribute(attrs: string, nonce: string): string {
  const withoutExistingNonce = attrs.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return ` nonce="${nonce}"${withoutExistingNonce}`;
}

/**
 * Injects a fresh nonce into every script and style opening tag.
 * Existing nonce attributes are replaced rather than duplicated.
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

// ── Security Header Setters ───────────────────────────────

export function setHtmlSecurityHeaders(headers: Headers, nonce: string): void {
  headers.set('Content-Security-Policy', buildCsp(nonce));
  setCommonSecurityHeaders(headers);
}

/**
 * Security headers for non-HTML assets. CSP is intentionally omitted because
 * it is enforced by the containing HTML document.
 */
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

// ── Path Detection ────────────────────────────────────────

/**
 * Returns true if the request path should be served as HTML.
 */
export function isHtmlPath(path: string): boolean {
  if (path === '/' || path === '') return true;

  const staticExts = /\.(css|js|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|eot|map|json|xml|txt|pdf|mp4|webm|mov)$/i;
  if (staticExts.test(path)) return false;

  if (/\.html$/i.test(path)) return true;

  // Cloudflare clean URLs remove the .html suffix.
  return !path.includes('.');
}
