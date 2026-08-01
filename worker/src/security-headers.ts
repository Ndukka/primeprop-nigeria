/**
 * PP-SEC-010 / PP-SEC-011: Security Headers & Strict CSP
 *
 * Provides nonce generation, CSP header construction, HTML nonce injection,
 * and security header setters for both HTML pages and API responses.
 */

// ── Nonce Generation ──────────────────────────────────────
// 192 bits of entropy (24 random bytes), base64url-encoded.
// Regenerated per-request so every page load gets a fresh, unguessable nonce.
export function generateNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Use base64 without padding and URL-safe characters
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── CSP Builders ──────────────────────────────────────────

/**
 * Strict CSP for HTML pages with nonce-based script/style execution.
 *
 * Directives rationale:
 *   default-src 'self'                  — lock down by default
 *   script-src 'nonce-...' 'strict-dynamic'
 *     — only scripts with the nonce run; 'strict-dynamic' lets trusted
 *       scripts (e.g. js/app.js) dynamically create <script> elements
 *   style-src 'self' 'nonce-...' https://cdnjs.cloudflare.com https://fonts.googleapis.com
 *     — self-hosted CSS + nonced inline <style> + Font Awesome + Google Fonts
 *   img-src 'self' data: https://images.unsplash.com
 *     — self (incl. R2 proxied via /api/images/) + data URIs + placeholder images
 *   font-src 'self' https://fonts.gstatic.com
 *     — self-hosted fonts + Google Fonts actual font files
 *   connect-src 'self'
 *     — only same-origin fetch/XHR (all API calls go to /api/*, /auth/*)
 *   frame-src https://www.youtube.com
 *     — property video embeds (YouTube iframes)
 *   frame-ancestors 'none'              — prevent clickjacking
 *   object-src 'none'                   — block Flash/plugins
 *   base-uri 'self'                     — prevent base tag injection
 *   form-action 'self'                  — prevent form hijacking
 */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "script-src 'nonce-" + nonce + "' 'strict-dynamic'",
    "style-src 'self' 'nonce-" + nonce + "' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "img-src 'self' data: https://images.unsplash.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "frame-src https://www.youtube.com",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/**
 * Minimal CSP for JSON API responses.
 * Prevents resource loading if an API response is somehow rendered as HTML.
 */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

// ── Nonce Injection ───────────────────────────────────────

/**
 * Injects nonce="..." into every <script> and <style> opening tag in the HTML.
 *
 * Handles:
 *   <script>             → <script nonce="...">
 *   <script src="...">   → <script nonce="..." src="...">
 *   <style>              → <style nonce="...">
 *   <style type="...">   → <style nonce="..." type="...">
 *
 * If a tag already has a nonce attribute, it is replaced with the fresh one.
 */
export function injectNonces(html: string, nonce: string): string {
  // Inject nonce into <script> tags
  html = html.replace(/<script(\s[^>]*)?>/gi, (_match, attrs) => {
    return '<script nonce="' + nonce + '"' + (attrs || '') + '>';
  });

  // Inject nonce into <style> tags
  html = html.replace(/<style(\s[^>]*)?>/gi, (_match, attrs) => {
    return '<style nonce="' + nonce + '"' + (attrs || '') + '>';
  });

  return html;
}

// ── Security Header Setters ───────────────────────────────

/**
 * Sets all security headers on an HTML response, including the strict
 * nonce-based CSP.
 */
export function setHtmlSecurityHeaders(headers: Headers, nonce: string): void {
  headers.set('Content-Security-Policy', buildCsp(nonce));
  setCommonSecurityHeaders(headers);
}

/**
 * Sets security headers for non-HTML static assets (CSS, JS, images, fonts).
 * Does NOT set CSP since it has no effect on non-HTML responses and can
 * cause issues with asset loading if misconfigured.
 */
export function setAssetSecurityHeaders(headers: Headers): void {
  // PP-SEC-042: X-XSS-Protection is obsolete — omitted
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

/**
 * Sets security headers on JSON API responses, including a restrictive
 * CSP that blocks all resource loading.
 */
export function setApiSecurityHeaders(headers: Headers): void {
  headers.set('Content-Security-Policy', API_CSP);
  setCommonSecurityHeaders(headers);
}

/**
 * Common security headers for all response types.
 */
function setCommonSecurityHeaders(headers: Headers): void {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
}

// ── Path Detection ────────────────────────────────────────

/**
 * Returns true if the request path should be served as an HTML page
 * (i.e. needs nonce injection and a full CSP).
 *
 * Covers:
 *   /                 → index.html
 *   /index.html       → explicit
 *   /admin.html       → explicit
 *   /properties.html  → explicit
 *   etc.
 */
export function isHtmlPath(path: string): boolean {
  if (path === '/' || path === '') return true;
  return /\.html$/i.test(path);
}
