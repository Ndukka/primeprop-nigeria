import { describe, expect, it } from 'vitest';
import {
  buildCsp,
  injectNonces,
  isHtmlPath,
  setHtmlSecurityHeaders,
} from '../src/security-headers';

describe('CSP regression coverage', () => {
  it('keeps scripts nonce-only and blocks all style attributes', () => {
    const csp = buildCsp('test-nonce');

    expect(csp).toContain("script-src 'nonce-test-nonce' 'strict-dynamic'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("style-src-attr 'none'");
    expect(csp).toContain("font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com");

    const scriptDirective = csp
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('script-src '));
    const styleAttributeDirective = csp
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('style-src-attr '));

    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(styleAttributeDirective).not.toContain("'unsafe-inline'");
  });

  it('allows the required external image font and video hosts only', () => {
    const csp = buildCsp('test-nonce');

    expect(csp).toContain('https://images.unsplash.com');
    expect(csp).toContain('https://randomuser.me');
    expect(csp).toContain('https://lh3.googleusercontent.com');
    expect(csp).toContain('https://www.youtube-nocookie.com');
    expect(csp).not.toContain('connect-src https:');
  });

  it('replaces existing nonces without injecting compatibility files', () => {
    const html = [
      '<html><head>',
      '<style nonce="old">body{display:block}</style>',
      '</head><body>',
      '<script nonce="old" src="/assets/app.123456789abc.js"></script>',
      '</body></html>',
    ].join('');

    const result = injectNonces(html, 'fresh');

    expect(result).toContain('<style nonce="fresh">');
    expect(result).toContain('<script nonce="fresh" src="/assets/app.123456789abc.js">');
    expect(result).not.toContain('nonce="old"');
    expect(result).not.toContain('csp-events.js');
    expect(result).not.toContain('csp-compat.css');
    expect(result.match(/nonce="fresh"/g)).toHaveLength(2);
  });

  it('is idempotent across repeated HTML rewriting', () => {
    const first = injectNonces('<script src="/assets/app.js"></script>', 'first');
    const second = injectNonces(first, 'second');

    expect(second).not.toContain('nonce="first"');
    expect(second).toContain('<script nonce="second" src="/assets/app.js">');
    expect(second.match(/nonce="second"/g)).toHaveLength(1);
  });

  it('removes stale validators and forbids browser storage of rewritten HTML', () => {
    const headers = new Headers({
      Age: '120',
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': '999',
      ETag: '"old-build"',
      Expires: 'Wed, 01 Jan 2031 00:00:00 GMT',
      'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      'Surrogate-Control': 'max-age=86400',
    });

    setHtmlSecurityHeaders(headers, 'fresh');

    expect(headers.get('Cache-Control')).toBe('private, no-store, max-age=0, must-revalidate');
    expect(headers.get('Pragma')).toBe('no-cache');
    expect(headers.get('Expires')).toBe('0');
    expect(headers.get('Age')).toBeNull();
    expect(headers.get('Content-Length')).toBeNull();
    expect(headers.get('ETag')).toBeNull();
    expect(headers.get('Last-Modified')).toBeNull();
    expect(headers.get('Surrogate-Control')).toBeNull();
    expect(headers.get('Content-Security-Policy')).toContain("script-src 'nonce-fresh'");
  });

  it('classifies clean HTML paths separately from static assets', () => {
    expect(isHtmlPath('/')).toBe(true);
    expect(isHtmlPath('/areas')).toBe(true);
    expect(isHtmlPath('/areas.html')).toBe(true);
    expect(isHtmlPath('/assets/styles.123456789abc.css')).toBe(false);
    expect(isHtmlPath('/assets/js/app.123456789abc.js')).toBe(false);
    expect(isHtmlPath('/media/tour.mp4')).toBe(false);
  });
});
