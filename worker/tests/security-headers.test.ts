import { describe, expect, it } from 'vitest';
import { buildCsp, injectNonces, isHtmlPath } from '../src/security-headers';

describe('CSP regression coverage', () => {
  it('keeps scripts nonce-only while permitting the existing inline CSS attributes', () => {
    const csp = buildCsp('test-nonce');

    expect(csp).toContain("script-src 'nonce-test-nonce' 'strict-dynamic'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toContain("font-src 'self' data: https://cdnjs.cloudflare.com https://fonts.gstatic.com");

    const scriptDirective = csp
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('script-src '));

    expect(scriptDirective).not.toContain("'unsafe-inline'");
  });

  it('allows the current external image and video hosts only', () => {
    const csp = buildCsp('test-nonce');

    expect(csp).toContain('https://images.unsplash.com');
    expect(csp).toContain('https://randomuser.me');
    expect(csp).toContain('https://lh3.googleusercontent.com');
    expect(csp).toContain('https://www.youtube-nocookie.com');
    expect(csp).not.toContain('connect-src https:');
  });

  it('replaces existing nonces and injects the compatibility assets once', () => {
    const html = [
      '<html><head>',
      '<style nonce="old">body{display:block}</style>',
      '</head><body>',
      '<script nonce="old" src="/js/app.js"></script>',
      '</body></html>',
    ].join('');

    const result = injectNonces(html, 'fresh');

    expect(result).toContain('<style nonce="fresh">');
    expect(result).toContain('<script nonce="fresh" src="/js/app.js">');
    expect(result).toContain('<link rel="stylesheet" href="/csp-compat.css">');
    expect(result).toContain('<script nonce="fresh" src="/js/csp-events.js" defer></script>');
    expect(result).not.toContain('nonce="old"');
    expect(result.match(/nonce="fresh"/g)).toHaveLength(3);
    expect(result.match(/\/csp-compat\.css/g)).toHaveLength(1);
    expect(result.match(/\/js\/csp-events\.js/g)).toHaveLength(1);
  });

  it('is idempotent across repeated HTML rewriting', () => {
    const first = injectNonces('<html><head></head><body></body></html>', 'first');
    const second = injectNonces(first, 'second');

    expect(second).not.toContain('nonce="first"');
    expect(second.match(/\/csp-compat\.css/g)).toHaveLength(1);
    expect(second.match(/\/js\/csp-events\.js/g)).toHaveLength(1);
    expect(second).toContain('<script nonce="second" src="/js/csp-events.js" defer></script>');
  });

  it('classifies clean HTML paths separately from static assets', () => {
    expect(isHtmlPath('/')).toBe(true);
    expect(isHtmlPath('/areas')).toBe(true);
    expect(isHtmlPath('/areas.html')).toBe(true);
    expect(isHtmlPath('/styles.css')).toBe(false);
    expect(isHtmlPath('/js/app.js')).toBe(false);
    expect(isHtmlPath('/media/tour.mp4')).toBe(false);
  });
});
