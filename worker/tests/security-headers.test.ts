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

  it('replaces an existing nonce instead of adding a duplicate', () => {
    const html = '<style nonce="old">body{display:block}</style><script nonce="old" src="/js/app.js"></script>';
    const result = injectNonces(html, 'fresh');

    expect(result).toContain('<style nonce="fresh">');
    expect(result).toContain('<script nonce="fresh" src="/js/app.js">');
    expect(result).not.toContain('nonce="old"');
    expect(result.match(/nonce="fresh"/g)).toHaveLength(2);
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
